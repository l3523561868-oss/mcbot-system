// 一键恢复 node_modules 补丁
// 用法：node apply-patches.mjs
// 把 patches/ 目录下备份的补丁文件复制回 node_modules/ 对应位置。
// 适用场景：npm install / 依赖重装后，node_modules 被还原，运行本脚本恢复补丁。
import fs from "fs";
import path from "path";
import url from "url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PATCHES = path.join(HERE, "patches");
const NODE_MODULES = path.join(HERE, "node_modules");

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (!name.endsWith(".md")) out.push(p); // 跳过说明文档
  }
  return out;
}

if (!fs.existsSync(PATCHES)) {
  console.log("没有 patches 目录，无需恢复。");
  process.exit(0);
}

let count = 0;
for (const f of walk(PATCHES)) {
  const rel = path.relative(PATCHES, f);
  const dest = path.join(NODE_MODULES, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
  count++;
  console.log("[+] " + rel + " -> " + dest);
}
console.log("完成：恢复 " + count + " 个补丁文件。");
