// 台股页面用繁体中文：Wind 返回的是简体，写入数据分支前在 GitHub Actions 里统一转换（opencc-js，台湾用语）。
// opencc-js 只在 Actions 里安装（见 .github/workflows/short-emotion.yml），Vercel 读接口不会用到；
// 没有安装时原样返回并给出提示，不影响数据更新。
import { pathToFileURL } from "node:url";

let converterPromise = null;

// Actions 把 opencc-js 装在临时目录（OPENCC_JS_DIR），避免为一个包安装整个前端依赖。
function openccSpecifier() {
  const dir = process.env.OPENCC_JS_DIR;
  return dir ? pathToFileURL(`${dir.replace(/\/+$/, "")}/node_modules/opencc-js/dist/esm/full.js`).href : "opencc-js";
}

async function getConverter() {
  converterPromise ||= import(openccSpecifier())
    .then((module) => (module.Converter || module.default?.Converter)({ from: "cn", to: "twp" }))
    .catch((error) => {
      console.warn(`opencc-js 未安装，台股文字保持简体：${error?.message || error}`);
      return null;
    });
  return converterPromise;
}

// opencc 台湾用语之外的修正：日常写法用「台」，以及证交所产业的正式名称。
export const HANT_FIXES = [
  [/臺/g, "台"], [/拉昇/g, "拉升"], [/釋出/g, "發布"],
  [/計算機及外圍(?:裝置|設備)/g, "電腦及週邊設備"], [/計算機/g, "電腦"], [/外圍(?:裝置|設備)/g, "週邊設備"], [/零元件/g, "零組件"], [/通訊網路/g, "通信網路"], [/分鍾/g, "分鐘"]
];
const fix = (text) => HANT_FIXES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);

// 代码、时间等不需要转换；只转换含中文的字符串值。
const HAS_CJK = /[一-鿿]/;

function convertDeep(value, convert) {
  if (typeof value === "string") return HAS_CJK.test(value) ? convert(value) : value;
  if (Array.isArray(value)) return value.map((item) => convertDeep(item, convert));
  if (value && typeof value === "object") {
    // 中文键（如「2连板」计数）也要转换；英文字段名保持不变。
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [HAS_CJK.test(key) ? convert(key) : key, convertDeep(item, convert)]));
  }
  return value;
}

export async function toTraditional(value) {
  const convert = await getConverter();
  return convert ? convertDeep(value, (text) => fix(convert(text))) : value;
}
