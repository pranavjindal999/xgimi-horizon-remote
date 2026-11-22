/**
 * Hardware volume keys → callback when the browser exposes them
 * (desktop / rare WebViews). Mobile Chrome/Safari do not deliver
 * VolumeUp/Down to the page, and a looping media element used to
 * "steal" them caused an audible click on open — so we no longer play audio.
 */

export function armPhoneVolume(onStep) {
  const onKey = (e) => {
    const up =
      e.key === "VolumeUp" ||
      e.key === "AudioVolumeUp" ||
      e.keyCode === 175 ||
      e.keyCode === 24;
    const down =
      e.key === "VolumeDown" ||
      e.key === "AudioVolumeDown" ||
      e.keyCode === 174 ||
      e.keyCode === 25;
    if (!up && !down) return;
    e.preventDefault();
    e.stopPropagation();
    onStep(up ? 1 : -1);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
