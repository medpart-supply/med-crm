// Збирає public/index.html: бере застосунок і підставляє серверне сховище замість window.storage.
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] || "../med/med-crm.html", "utf8");

const SHIM = `
<script>
/* ---------------------------------------------------------------
   Серверне сховище. У Claude застосунок користується window.storage;
   на Render його немає, тому тут той самий інтерфейс поверх /api/kv.
   Ключ сесії лишається у браузері, решта — спільна для всіх.
----------------------------------------------------------------*/
(function(){
  var LOCAL = function(k){ return String(k).indexOf("medcrm:sess") === 0; };
  var revs = {}, syncing = false;

  async function req(method, url, body){
    var r = await fetch(url, {
      method: method, credentials: "same-origin",
      headers: body ? {"Content-Type":"application/json"} : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if(r.status === 401){ location.href = "/login"; throw new Error("Потрібен вхід"); }
    return r;
  }

  window.storage = {
    async get(key){
      if(LOCAL(key)){
        var v = localStorage.getItem(key);
        if(v === null) throw new Error("Ключа немає");
        return {key:key, value:v};
      }
      var r = await req("GET", "/api/kv/" + encodeURIComponent(key));
      if(r.status === 404) throw new Error("Ключа немає");
      var j = await r.json(); revs[key] = j.rev;
      return {key:key, value:j.value};
    },
    async set(key, value){
      if(LOCAL(key)){ localStorage.setItem(key, value); return {key:key, value:value}; }
      var r = await req("PUT", "/api/kv/" + encodeURIComponent(key),
                        {value:value, rev: revs[key] == null ? null : revs[key]});
      if(r.status === 409){ conflict(); throw new Error("Дані змінив інший користувач"); }
      var j = await r.json(); revs[key] = j.rev;
      return {key:key, value:value};
    },
    async delete(key){
      if(LOCAL(key)){ localStorage.removeItem(key); return {key:key, deleted:true}; }
      await req("DELETE", "/api/kv/" + encodeURIComponent(key));
      delete revs[key];
      return {key:key, deleted:true};
    },
    async list(prefix){
      var r = await req("GET", "/api/kv?prefix=" + encodeURIComponent(prefix || ""));
      return await r.json();
    }
  };

  /* Якщо базу змінив інший підрозділ — попереджаємо і перезавантажуємо,
     але не посеред заповнення форми. */
  function conflict(){ banner("Дані оновив інший користувач. Сторінку буде перезавантажено, щоб ви бачили актуальні залишки."); }

  var pending = false;
  function banner(text){
    if(pending) return; pending = true;
    var b = document.createElement("div");
    b.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:999;background:#9A6B0E;color:#fff;" +
      "padding:11px 16px;font:14px/1.4 'IBM Plex Sans',system-ui,sans-serif;text-align:center";
    b.textContent = text;
    document.body.appendChild(b);
    (function wait(){
      var busy = document.getElementById("modal-root") && document.getElementById("modal-root").innerHTML.length;
      if(busy) return setTimeout(wait, 1500);
      setTimeout(function(){ location.reload(); }, 1200);
    })();
  }

  /* дві серверні кнопки в блоці профілю */
  document.addEventListener("DOMContentLoaded", function(){
    var box = document.getElementById("meBox");
    if(!box) return;
    var add = function(){
      var acts = box.querySelector(".me-acts");
      if(!acts || acts.querySelector("[data-srv]")) return;
      var a = document.createElement("button");
      a.dataset.srv = "1"; a.textContent = "Копія бази";
      a.title = "Завантажити резервну копію всієї бази у файл";
      a.onclick = function(){ location.href = "/api/backup"; };
      var b = document.createElement("button");
      b.dataset.srv = "1"; b.textContent = "Вийти з сайту";
      b.onclick = async function(){ await fetch("/api/logout", {method:"POST"}); location.href = "/login"; };
      acts.appendChild(a); acts.appendChild(b);
    };
    new MutationObserver(add).observe(box, {childList:true, subtree:true});
    add();
  });

  setInterval(async function(){
    if(syncing || pending || document.hidden) return;
    syncing = true;
    try{
      var key = "medcrm:v1";
      if(revs[key] != null){
        var r = await fetch("/api/rev/" + encodeURIComponent(key), {credentials:"same-origin"});
        if(r.ok){
          var j = await r.json();
          if(j.rev > revs[key]) banner("Дані оновив інший користувач. Оновлюю сторінку…");
        }
      }
    }catch(e){}
    syncing = false;
  }, 20000);
})();
</script>
`;

// вставляємо заглушку перед основним скриптом застосунку
const i = src.lastIndexOf("<script>");
if (i < 0) { console.error("Не знайдено скрипт застосунку"); process.exit(1); }
let out = src.slice(0, i) + SHIM + src.slice(i);

// кнопка резервної копії в шапці — просто посилання на /api/backup
out = out.replace('<div id="actions" class="row"></div>',
  '<div id="actions" class="row"></div>');

if (!out.startsWith("<!doctype")) out = "<!doctype html>\n" + out;
fs.mkdirSync("public", {recursive:true});
fs.writeFileSync("public/index.html", out);
console.log("public/index.html зібрано, розмір", (out.length/1024).toFixed(0), "КБ");
