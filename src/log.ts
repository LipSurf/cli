// --- hack until @lipsurf/common is available here
function padTwo(num) {
  return num.toString().padStart(2, "0");
}
// --- end hack

const _timedLog =
  (type) =>
  (...msgs: string[]) => {
    const now = new Date();
    console[type](
      `[${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(
        now.getSeconds()
      )}]`,
      ...msgs
    );
  };

export const timedLog = _timedLog("log");
export const timedErr = _timedLog("error");
