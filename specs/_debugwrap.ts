import { wrapBatch } from "@based/core";
console.log(wrapBatch("SELECT 1 AS a", { capturePlan: true }));
