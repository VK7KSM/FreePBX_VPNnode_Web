const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'});
const clockFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function sydneyDate(ms=Date.now()) {
  const p=Object.fromEntries(dateFormat.formatToParts(ms).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;
}
export function dateShift(day,n) {return new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function sydneyMidnight(day) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||dateShift(day,0)!==day) throw new Error('日期无效');
  const target=Date.parse(day+'T00:00:00Z');let guess=target;
  for(let i=0;i<3;i++) {
    const p=Object.fromEntries(clockFormat.formatToParts(guess).map(p=>[p.type,p.value]));
    const local=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);guess+=target-local;
  }
  return guess;
}
export function aggregateDailyTraffic(samples,from,to,now=Date.now()) {
  const rows=[];
  for(let day=from;day<=to;day=dateShift(day,1)) rows.push({date:day,start:sydneyMidnight(day),end:sydneyMidnight(dateShift(day,1)),rx_bytes:0,tx_bytes:0,observed_ms:0,estimated:false,gaps:false,available:false});
  const points=[...new Map(samples.filter(s=>s?.available && s.sampled_at_ms<=now && s.sampled_at_ms>=s.started_at_ms).sort((a,b)=>a.sampled_at_ms-b.sampled_at_ms).map(s=>[(s.installation_id||'legacy')+':'+s.sampled_at_ms,s])).values()];
  let previous=null;
  for(const sample of points) {
    if(!previous || previous.installation_id!==sample.installation_id || previous.started_at_ms!==sample.started_at_ms) {
      previous={...sample,sampled_at_ms:sample.started_at_ms,rx_bytes:0,tx_bytes:0,covered_ms:0,gaps:0};
    }
    const start=previous.sampled_at_ms,end=sample.sampled_at_ms,rx=sample.rx_bytes-previous.rx_bytes,tx=sample.tx_bytes-previous.tx_bytes;
    if(end>start && rx>=0 && tx>=0) {
      const cross=sydneyDate(start)!==sydneyDate(end-1),gap=sample.gaps>previous.gaps || sample.covered_ms-previous.covered_ms<end-start-2000;
      for(const row of rows) {
        const a=Math.max(start,row.start),b=Math.min(end,row.end);if(b<=a) continue;
        // 用累计比例差分保证整段跨日分摊后字节守恒，不推算最后采样之后的用量。
        for(const [key,delta] of [['rx_bytes',rx],['tx_bytes',tx]]) row[key]+=Math.round(delta*(b-start)/(end-start))-Math.round(delta*(a-start)/(end-start));
        row.observed_ms+=b-a;row.available=true;row.estimated ||= cross;row.gaps ||= gap;
      }
    }
    previous=sample;
  }
  return rows.map(row=>({...row,partial:!row.available || row.gaps || row.observed_ms<Math.max(0,Math.min(row.end,now)-row.start)-2000}));
}
export async function queryDailyTraffic(storage,url,now=Date.now()) {
  const p=url.searchParams,device=p.get('device_id');if(!device||device.length>128) throw new Error('缺少有效设备编号');
  const to=p.get('to')||sydneyDate(now),from=p.get('from')||dateShift(to,-29);
  const start=sydneyMidnight(from),end=sydneyMidnight(dateShift(to,1));sydneyMidnight(to);
  if(from>to || (Date.parse(to)-Date.parse(from))/86400000>365) throw new Error('请选择不超过366天的日期范围');
  const prefix='history/'+encodeURIComponent(device)+'/',low=prefix+new Date(start).toISOString(),high=prefix+new Date(end).toISOString();
  const samples=[];
  // 历史记录按上报时间排序；取区间两侧最近的有效计量，供午夜边界差分。
  async function adjacent(reverse,bound) {
    let cursor;
    while(true) {
      const options=reverse?{end:cursor||bound}:{start:cursor||bound};
      const entries=[...await storage.list({prefix,...options,reverse,limit:500})];
      for(const [,row] of entries) if(row.traffic?.available) {samples.push({...row.traffic,installation_id:row.installation_id});return;}
      if(entries.length<500) return;
      cursor=reverse?entries.at(-1)[0]:entries.at(-1)[0]+'\0';
    }
  }
  await adjacent(true,low);
  let cursor;
  while(true) {
    const entries=[...await storage.list({prefix,...(cursor?{startAfter:cursor}:{start:low}),end:high,limit:500})];
    for(const [,row] of entries) if(row.traffic) samples.push({...row.traffic,installation_id:row.installation_id});
    if(entries.length<500) break;cursor=entries.at(-1)[0];
  }
  if(end<=now) await adjacent(false,high);
  return {ok:true,timezone:'Australia/Sydney',from,to,days:aggregateDailyTraffic(samples,from,to,now),sampled_at_ms:Math.max(0,...samples.filter(s=>s.available&&s.sampled_at_ms<=now).map(s=>s.sampled_at_ms))};
}
