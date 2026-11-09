// 生成台股页面用的简→繁字表（public/short-emotion/hant-map.js）。
// 页面文字改动后重新运行：npm install --no-save opencc-js@1.0.5 && node scripts/short-emotion/build-hant-map.mjs
import { readFile, writeFile } from "node:fs/promises";
import * as OpenCC from "opencc-js";

const sources = [
  "public/short-emotion/index.html",
  "public/short-emotion/app.js",
  "api/_lib/short-emotion/engine.js",
  "api/_lib/short-emotion/tw-engine.js",
  "api/_lib/short-emotion/service.js",
  "api/_lib/short-emotion/schedule.js"
];
const text = (await Promise.all(sources.map((file) => readFile(file, "utf8")))).join("");
const chars = [...new Set(text.match(/[一-鿿]/g))].sort();
const convert = OpenCC.Converter({ from: "cn", to: "tw" });
const map = {};
for (const char of chars) {
  const traditional = convert(char);
  if (traditional !== char && traditional.length === 1) map[char] = traditional;
}
const output = `// 自动生成：scripts/short-emotion/build-hant-map.mjs（opencc-js cn→tw，逐字），请勿手改。
// 台股页面（/tw-short-emotion）用它把界面文字转成繁体；数据在定时任务里已用 opencc 按词转换。
export const HANT = ${JSON.stringify(map)};

// 与 api/_lib/short-emotion/hant.js 保持一致：日常写法用「台」，以及证交所产业正式名称。
export const HANT_FIXES = [
  [/臺/g, "台"], [/拉昇/g, "拉升"], [/信息服務/g, "資訊服務"], [/計算機及外圍(?:裝置|設備)/g, "電腦及週邊設備"],
  [/計算機/g, "電腦"], [/外圍(?:裝置|設備)/g, "週邊設備"], [/零元件/g, "零組件"], [/軟件/g, "軟體"], [/網絡/g, "網路"], [/鍾/g, "鐘"]
];
`;
await writeFile("public/short-emotion/hant-map.js", output);
console.log(`hant-map.js: ${Object.keys(map).length} chars`);
