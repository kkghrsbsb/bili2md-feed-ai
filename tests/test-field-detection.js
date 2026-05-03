// 获取实际的 __data 结构，判断主评论和子评论的字段路径

const bc = document.querySelector('#commentapp bili-comments, bili-comments');
const threads = bc?.shadowRoot?.querySelectorAll('bili-comment-thread-renderer');
const t = threads?.[0];
console.log('__data keys:', Object.keys(t?.__data || {}));
console.log('__data:', JSON.stringify(t?.__data, null, 2).slice(0, 2000));
