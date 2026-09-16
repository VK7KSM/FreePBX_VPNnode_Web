#!/usr/bin/env node
import net from 'node:net';
import process from 'node:process';
import {pathToFileURL} from 'node:url';
import {WebSocket} from 'ws';

const FRAME_LIMIT=64*1024;
const BUFFER_LIMIT=1024*1024;

export async function startBridge({url,token,port=0,WebSocketImpl=WebSocket,netModule=net,stdout=process.stdout,stderr=process.stderr}={}){
  const endpoint=validateEndpoint(url);
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('缺少有效的host令牌');
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('本地端口无效');
  let active=null,settled=false,finishResolve;
  const done=new Promise(resolve=>{finishResolve=resolve;});
  const finish=()=>{if(settled)return;settled=true;try{server.close();}catch{}finishResolve();};
  const server=netModule.createServer(socket=>{
    if(active){socket.destroy();return;}
    active=socket;server.close();
    let opened=false,pending=[],pendingBytes=0,closed=false;
    const ws=new WebSocketImpl(endpoint.toString(),{
      headers:{Authorization:'Bearer '+token},perMessageDeflate:false,maxPayload:FRAME_LIMIT,
      handshakeTimeout:15000,followRedirects:false
    });
    const closeAll=(code=1000,reason='local_closed')=>{
      if(closed)return;closed=true;pending=[];pendingBytes=0;
      try{if(ws.readyState===0||ws.readyState===1)ws.close(code,reason);}catch{}
      if(!socket.destroyed)socket.destroy();finish();
    };
    socket.on('data',chunk=>{
      for(let offset=0;offset<chunk.length;offset+=FRAME_LIMIT){
        const frame=chunk.subarray(offset,Math.min(chunk.length,offset+FRAME_LIMIT));
        if(opened){
          if(Number(ws.bufferedAmount||0)+frame.length>BUFFER_LIMIT){closeAll(1009,'backpressure_limit');return;}
          try{ws.send(frame,{binary:true});}catch{closeAll(1011,'host_send_failed');return;}
        }else{
          if(pendingBytes+frame.length>BUFFER_LIMIT){closeAll(1009,'backpressure_limit');return;}
          pending.push(Buffer.from(frame));pendingBytes+=frame.length;
        }
      }
    });
    socket.on('end',()=>closeAll(1000,'local_closed'));
    socket.on('error',()=>closeAll(1011,'local_error'));
    socket.on('close',()=>{if(!closed)closeAll(1000,'local_closed');});
    ws.on('open',()=>{
      opened=true;
      for(const frame of pending){
        if(Number(ws.bufferedAmount||0)+frame.length>BUFFER_LIMIT){closeAll(1009,'backpressure_limit');return;}
        try{ws.send(frame,{binary:true});}catch{closeAll(1011,'host_send_failed');return;}
      }
      pending=[];pendingBytes=0;
    });
    ws.on('message',(data,isBinary)=>{
      if(!isBinary){closeAll(1003,'binary_required');return;}
      const frame=Buffer.from(data);
      if(frame.length>FRAME_LIMIT||socket.writableLength+frame.length>BUFFER_LIMIT){closeAll(1009,'backpressure_limit');return;}
      try{socket.write(frame);}catch{closeAll(1011,'local_send_failed');}
    });
    ws.on('close',()=>{closed=true;if(!socket.destroyed)socket.destroy();finish();});
    ws.on('error',()=>{stderr.write('ADB隧道连接失败\n');closeAll(1011,'host_error');});
  });
  server.on('error',error=>{stderr.write('本地ADB监听失败\n');if(active&&!active.destroyed)active.destroy();finish();});
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen({host:'127.0.0.1',port},()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();
  stdout.write('本地ADB隧道已监听 127.0.0.1:'+address.port+'\n');
  stdout.write('执行: adb connect 127.0.0.1:'+address.port+'\n');
  return {server,address,done,close:()=>{if(active&&!active.destroyed)active.destroy();finish();}};
}

function validateEndpoint(value){
  let url;try{url=new URL(value);}catch{throw Error('host WSS地址无效');}
  if(url.protocol!=='wss:'||url.hostname!=='v.elfradio.net'||url.username||url.password||url.hash
      ||url.pathname!=='/api/elfremote/adb-tunnel/host')throw Error('host WSS地址无效');
  if([...url.searchParams.keys()].some(key=>key!=='session_id')||!/^[a-f0-9-]{36}$/.test(url.searchParams.get('session_id')||''))throw Error('host WSS会话无效');
  return url;
}

function parseArgs(argv){
  const result={port:0};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--url')result.url=argv[++i];
    else if(argv[i]==='--port')result.port=Number(argv[++i]);
    else throw Error('参数无效: '+argv[i]);
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const args=parseArgs(process.argv.slice(2)),token=process.env.ELFREMOTE_ADB_TUNNEL_TOKEN||'';
    delete process.env.ELFREMOTE_ADB_TUNNEL_TOKEN;
    const bridge=await startBridge({...args,token});
    const stop=()=>bridge.close();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    await bridge.done;
  }catch(error){process.stderr.write((error?.message||'ADB隧道启动失败')+'\n');process.exitCode=1;}
}
