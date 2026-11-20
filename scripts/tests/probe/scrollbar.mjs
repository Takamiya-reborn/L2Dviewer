// 自绘滚动条几何诊断：浏览器控制台 import('/probes/scrollbar.mjs') 执行。
// 输出每个滚动视口的尺寸、内容高度、滚动事件是否触发、滑块位置，用于排查"滑块不动"。

const viewports = [...document.querySelectorAll(".viewport")];
console.log(`viewport 数量: ${viewports.length}`);

for (const [index, el] of viewports.entries()) {
  const cs = getComputedStyle(el);
  const info = {
    index,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    overflowY: cs.overflowY,
    display: cs.display,
    position: cs.position,
    parentH: el.parentElement.clientHeight,
    parentOverflow: getComputedStyle(el.parentElement).overflow,
  };
  console.log(`viewport[${index}]`, info);

  let fired = 0;
  const onScroll = () => fired++;
  el.addEventListener("scroll", onScroll);
  const top0 = el.scrollTop;
  el.scrollTop = top0 + 100;
  setTimeout(() => {
    el.scrollTop = top0;
    el.removeEventListener("scroll", onScroll);
    console.log(
      `viewport[${index}] 程序化滚动 100px: scrollTop ${top0} -> 实际 ${el.scrollTop}, scroll 事件触发 ${fired} 次`,
    );
    const track = el.parentElement.parentElement.querySelector(".track");
    const thumb = track?.querySelector(".thumb");
    console.log(
      `track 存在: ${!!track}`,
      track
        ? `可见 ${getComputedStyle(track).display !== "none"}, 位置 right=${getComputedStyle(track).right} 高=${track.clientHeight}`
        : "",
    );
    console.log(
      `thumb 存在: ${!!thumb}`,
      thumb ? `top=${thumb.style.top} height=${thumb.style.height}` : "",
    );
    if (index === viewports.length - 1)
      console.log(
        "--- 诊断完成：滚动列表后若 scrollTop 变化而 thumb top 不变，把上面输出贴给 Claude ---",
      );
  }, 100);
}
