import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const source=fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function renderRemoteConsole(){'),source.indexOf('function openTrafficHistory(){'));
test('通信终端首次及刷新渲染均将连接入口置于设备名和历史记录之间',()=>{
 const box={innerHTML:'',querySelector:()=>null},device={id:'synthetic',name:'测试设备'};let connects=0,mounts=0;
 const media={connectionControl(d){assert.equal(d,device);connects++;return '<button>连接</button>';},isActive:()=>false,preview:(d,h)=>h,controls:()=>'',feedback:()=>'',mount(){mounts++;}};
 const ctx={$:()=>box,currentDev:()=>device,trafficDay:()=>'',DAILY_CACHE:{},serviceErrorText:()=>'',esc:s=>s,ElfMedia:media,trajectoryPreview:()=>null,trajectoryEvent:()=>null,reportPhotoHtml:()=>'',trajectoryMount(){},loadReportPhotos(){},document:{hidden:true}};
 vm.runInNewContext(render,ctx);ctx.renderRemoteConsole();ctx.renderRemoteConsole();assert.equal(connects,2);assert.equal(mounts,2);
 assert.ok(box.innerHTML.indexOf('测试设备')<box.innerHTML.indexOf('<button>连接</button>'));assert.ok(box.innerHTML.indexOf('<button>连接</button>')<box.innerHTML.indexOf('历史记录'));
});
