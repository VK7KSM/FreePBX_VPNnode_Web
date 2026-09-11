// 媒体对象七天清理；小型事件索引随轨迹保留，不保存正文或访问凭据。
export function mediaEvent(record,type=record.type){
  const start=typeof record.captured_at==='number'?record.captured_at:Date.parse(record.captured_at);
  if(!Number.isFinite(start)||!record.device_id)return null;
  return {id:type==='photo'?record.report_id:record.id,type,report_id:record.report_id||null,
    timeline_at:type==='photo'&&record.report_timeline_at?Date.parse(record.report_timeline_at):start,captured_at:start,ended_at:start+(Number(record.duration_ms)||0),duration_ms:Number(record.duration_ms)||0,
    expires_at:record.expires_at,complete:record.complete!==false,manual:record.manual===true,
    time_source:record.time_source||(type==='photo'?'device':'server'),mime:record.mime||'image/jpeg'};
}
export async function archiveMedia(storage,record,type=record.type){
  const event=mediaEvent(record,type);if(!event)return;
  await storage.put('trajectory-media/'+encodeURIComponent(record.device_id)+'/'+new Date(event.timeline_at??event.captured_at).toISOString()+'/'+type+'-'+event.id,event);
}
export async function queryTrajectoryMedia(storage,url,now=Date.now()){
  const p=url.searchParams,device=p.get('device_id'),from=Date.parse(p.get('from')),to=Date.parse(p.get('to'));
  if(!device||device.length>128||!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw Error('媒体时间范围无效');
  const prefix='trajectory-media/'+encodeURIComponent(device)+'/',start=prefix+new Date(from-1800000).toISOString(),end=prefix+new Date(to).toISOString()+'~';
  const cursor=p.get('cursor');
  if(cursor&&(!cursor.startsWith(prefix)||cursor<start||cursor>=end))throw Error('媒体分页位置无效');
  const key=e=>prefix+new Date(e.timeline_at??e.captured_at).toISOString()+'/'+e.type+'-'+e.id;
  const all=new Map();
  function include(e){const at=e?.timeline_at??e?.captured_at;if(e&&at<=to&&(e.type==='photo'?at:e.ended_at)>=from&&(!cursor||key(e)>cursor))all.set(e.type+':'+e.id,e);}
  // 索引直接按游标读下一页，避免每页重新扫描整段历史。
  let after=cursor;
  for(;;){const rows=await storage.list({prefix,...(after?{startAfter:after}:{start}),end,limit:501});
    for(const event of rows.values())include(event);
    if(rows.size<501||all.size>500)break;after=[...rows.keys()].at(-1);
  }
  // 兼容上线前仍保留的七天媒体；元数据更新也能补充未完整结束的录制时长。
  if(to>=now-7*86400000){
    for(const [legacy,type] of [['report-photo/'+device+'/','photo'],['media-record/'+device+'/',null]]){
      let after;
      for(;;){const rows=await storage.list({prefix:legacy,...(after?{startAfter:after}:{}),limit:500});
        for(const record of rows.values())if(record.ready&&record.expires_at>now)include(mediaEvent(record,type||record.type));
        if(rows.size<500)break;after=[...rows.keys()].at(-1);
      }
    }
  }
  const ordered=[...all.values()].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0),page=ordered.slice(0,500);
  return {ok:true,records:page.map(e=>({...e,expired:e.expires_at<=now})),next_cursor:ordered.length>500?key(page.at(-1)):null};
}
