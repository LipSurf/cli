import { transformJSToPlugin } from "./transform";

process.on("message", (msg: Parameters<typeof transformJSToPlugin>) => {
  // console.log("Message from parent:", msg);
  transformJSToPlugin(...msg)
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
