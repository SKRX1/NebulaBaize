// 第1项交付物：真机只读扫描探针（纯只读，粘贴到 8099 浏览器控制台运行即得统计，绝不修改任何数据）。
// 直接观测存量便签 localStorage("strata.spark") 里：已被旧 sanitize 剥空 href 的删除按钮(空壳死壳)、
// 以及已被剥空 src 的破图 —— 这两项正是"中招"的可观测标记，就是迁移决策要的数据。
//
// 【关键事实】您在真机硬刷新后看到的"保存后删除按钮丢失"——正是本轮已落地修复的那个 bug
//   （sanitizeHtml 把 icon("trash") 的 sprite href web/sprite.svg#i-trash 剥空 -> <use> 空 -> 图标空白）。
//   修复只对"修复后新粘贴+保存"的便签生效；存量旧便签的数据里 href 已被剥空、不会自动恢复，
//   这正是第3项"迁移"要解决的（把存量旧便签重新走一遍新逻辑/重存）。
(function scanSparkLegacy(){
  let arr=[];
  try{ arr=JSON.parse(localStorage.getItem("strata.spark")||"[]"); }catch(e){ console.log("read fail:",e); return; }
  const d=document.createElement("div");
  let sparksWithThumb=0, deadShellDeleteButtons=0, brokenNoSrcImgs=0, total=0;
  for(const s of arr){
    const h=s.html||"";
    if(!/ce-thumb|<img/i.test(h)) continue;
    total++; sparksWithThumb++;
    d.innerHTML=h;
    d.querySelectorAll("button.ce-thumb__x").forEach(b=>{
      const u=b.querySelector("use");
      if(!u || !(u.getAttribute("href")||u.getAttribute("xlink:href"))) deadShellDeleteButtons++;
    });
    d.querySelectorAll("img").forEach(img=>{ if(!img.getAttribute("src")) brokenNoSrcImgs++; });
  }
  const out={sparks_total:arr.length, sparks_with_thumb:total,
    dead_shell_delete_buttons:deadShellDeleteButtons, broken_no_src_imgs:brokenNoSrcImgs};
  console.log("SPARK LEGACY SCAN:", JSON.stringify(out,null,2));
  return out;
})();
