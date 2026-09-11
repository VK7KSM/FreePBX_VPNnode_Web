import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import source from './devices-client-source.js';
function browser(){const c=vm.createContext({Date,adminSession:{check(){}},setTimeout(){},setInterval(){}});vm.runInContext(source,c);c.renderOps=()=>{};return c;}
test('旧D31未声明能力也显示Nexui与QUIK预设表单，不能提交或退回D22软件',()=>{
 const c=browser();c.DEV=[{id:'d31',model_id:'mdl_d31',model_name:'D31',enabled:true,status_only:true,managed_sip_account:false}];c.selDev='d31';
 let html=c.pageAccountSettings('');assert.match(html,/Nexui 电话/);assert.match(html,/QUIK 短信/);assert.doesNotMatch(html,/Linphone|Zello|保存并登录/);assert.match(html,/id="sipAccountAuth"/);assert.match(html,/type="submit" class="btn-green" disabled/);
 c.selectAccountTab('QUIK');html=c.pageAccountSettings('');assert.doesNotMatch(html,/id="sipAccountAuth"/);assert.match(html,/data-sip-selection="quik\|"/);assert.match(html,/等待客户端支持/);
});
test('型号改名不改软件预设，D22与D31切换不继承对方账号页，未适配型号不冒充D22',()=>{
 const c=browser();c.MODELS=[{id:'custom',name:'客厅座机',registration_key:'d31'}];c.DEV=[{id:'d31',model_id:'custom'},{id:'d22',model_id:'mdl_d22'},{id:'h13',model_id:'mdl_h13'},{id:'future',model_id:'new'}];
 c.selDev='d31';c.pageAccountSettings('');c.selectAccountTab('QUIK');
 c.selDev='d22';let html=c.pageAccountSettings('');assert.match(html,/Linphone/);assert.match(html,/Zello/);assert.doesNotMatch(html,/Nexui|QUIK/);c.selectAccountTab('Zello');
 c.selDev='d31';html=c.pageAccountSettings('');assert.equal(c.uiOf().accountTab,'QUIK');assert.match(html,/data-sip-selection="quik\|"/);
 c.selDev='d22';c.pageAccountSettings('');assert.equal(c.uiOf().accountTab,'Zello');
 c.selDev='h13';assert.deepEqual(Array.from(c.accountSoftware(c.currentDev())),['Zello']);
 c.selDev='future';assert.match(c.pageAccountSettings(''),/尚未配置账号项目/);c.currentDev().managed_zello_account=true;assert.match(c.pageAccountSettings(''),/普通Zello账号/);
});
test('D31实际多账号按所选软件过滤，切换QUIK不会显示或提交Nexui线路',()=>{
 const c=browser();const d={id:'d31',model_id:'mdl_d31',enabled:true,status_only:true,managed_sip_account:true,sip_targets:[{target:'nexui',auth_username_supported:true,accounts:[{account_id:'a'}]},{target:'quik',auth_username_supported:false,accounts:[{account_id:'default'}]}],sip_accounts:[{target:'nexui',account_id:'a',target_label:'Nexui 电话',label:'电话线路',configuration:{server:'phone.invalid',username:'phone'}},{target:'quik',account_id:'default',target_label:'QUIK 短信',label:'短信账号',configuration:{server:'sms.invalid',username:'sms'}}]};c.DEV=[d];c.selDev=d.id;
 let html=c.pageAccountSettings('');assert.match(html,/phone.invalid/);assert.doesNotMatch(html,/sms.invalid/);assert.equal(c.selectedSipAccount().target,'nexui');
 c.selectAccountTab('QUIK');html=c.pageAccountSettings('');assert.match(html,/sms.invalid/);assert.doesNotMatch(html,/phone.invalid|电话线路/);assert.equal(c.selectedSipAccount().target,'quik');assert.doesNotMatch(html,/type="submit" class="btn-green" disabled/);
 c.selectAccountTab('Linphone');assert.equal(c.uiOf().accountTab,'QUIK');
});
