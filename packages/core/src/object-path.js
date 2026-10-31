// 对象 key 直接进入 CDN URL；配置、发布和浏览器须接受同一组无需转义的相对路径。
export function isSafeObjectKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function isSafeObjectPrefix(value) {
  return typeof value === 'string' && value.endsWith('/') && isSafeObjectKey(value.slice(0, -1));
}
