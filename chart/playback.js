"use strict";

export function createPlayback({ $, windowLoader }) {
  let replayTimer = 0;

  function play() {
    if (replayTimer) return;
    $("btn-play").textContent = "Pause";

    const tick = () => {
      if (windowLoader.index() >= windowLoader.lastIndex()) {
        windowLoader.maybePrefetch().then(() => {
          if (windowLoader.index() >= windowLoader.lastIndex()) stop();
          else {
            windowLoader.setIndex(windowLoader.index() + 1);
            replayTimer = setTimeout(tick, speed());
          }
        });
        return;
      }

      windowLoader.setIndex(windowLoader.index() + 1);
      replayTimer = setTimeout(tick, speed());
    };

    replayTimer = setTimeout(tick, speed());
  }

  function stop() {
    clearTimeout(replayTimer);
    replayTimer = 0;
    $("btn-play").textContent = "Play";
  }

  function toggle() {
    if (replayTimer) stop();
    else play();
  }

  function isPlaying() {
    return Boolean(replayTimer);
  }

  function speed() {
    return Number($("speed").value) || 120;
  }

  return { play, stop, toggle, isPlaying };
}
