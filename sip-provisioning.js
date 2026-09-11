// 仅服务端把管理分机解析成设备配置，浏览器不接收分机密码。
export function sipDirectory(bundle) {
  return (bundle.extensions || []).map(row => ({
    extension: String(row.ext), name: String(row.name || ''),
    sms: row.sms === true, available: !!bundle.secrets?.[row.ext]
  }));
}

export function managedSipParams(input, bundle) {
  if (!input || input.source !== 'managed' || !['nexui', 'quik'].includes(input.target)
      || typeof input.extension !== 'string' || !/^[0-9]{3,6}$/.test(input.extension))
    throw Error('请选择有效的管理分机及目标应用');
  if (Object.keys(input).some(key => !['source','extension','target','account_id'].includes(key)))
    throw Error('管理分机配置不能混入手动服务器参数');
  const row = (bundle.extensions || []).find(row => String(row.ext) === input.extension);
  if (!row) throw Error('该分机已不存在，请刷新账号列表');
  if (input.target === 'quik' && row.sms !== true) throw Error('请先在SIP管理中开启该分机的短信权限');
  const password = bundle.secrets?.[input.extension];
  if (typeof password !== 'string' || !password) throw Error('该分机尚未设置密码');
  return {target:input.target, account_id:input.account_id,
    server:'sip.elfradio.net', username:input.extension, auth_username:input.extension,
    password, ...(input.target==='quik'?{realm:'*'}:{}), transport:'tls', port:5061};
}
