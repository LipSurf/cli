import { transformJSToPlugin } from "./transform";

process.on("message", (msg) => {
  // console.log("Message from parent:", msg);
  // @ts-ignore
  transformJSToPlugin(...msg)
    .then(() => {
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
});
