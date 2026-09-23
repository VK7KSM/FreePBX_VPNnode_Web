// 读 wrangler.jsonc 这类带注释的 JSON。
//
// 直接 JSON.parse 会炸：wrangler 的配置里写着为什么 workers_dev 必须保持 false，
// 那段注释是要留着的——两次 Worker 被停用都和那个开关有关，把原因删掉换个能解析的格式，
// 下次有人就会重新打开它。所以是解析器迁就配置，不是配置迁就解析器。
//
// 不用正则一把梭剥注释：配置里有 "https://api.cloudflare.com/..." 这样的值，
// 里面的 // 是字符串的一部分，剥掉就把地址弄坏了。所以要逐字符走一遍，知道自己在不在字符串里。
export function parseJsonc(text) {
  let out = '', inString = false, escaped = false, comment = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (comment === 'line') { if (c === '\n') { comment = ''; out += c; } continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    out += c;
  }
  if (inString) throw Error('配置里有没有收尾的字符串');
  if (comment === 'block') throw Error('配置里有没有收尾的块注释');
  return JSON.parse(dropTrailingCommas(out));
}

// jsonc 允许 {"a":1,} 这样的收尾逗号。同样要认字符串——值里真的可能写着 ", }"。
function dropTrailingCommas(text) {
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;   // 收尾逗号，丢掉
    }
    out += c;
  }
  return out;
}
