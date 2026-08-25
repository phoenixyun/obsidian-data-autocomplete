/* fs stub：插件从不直接读写文件系统（全部走 Obsidian vault.adapter API）。
 * xlsx 库内部会 require("fs") 用于可选的 set_fs 路径，这里提供空实现，
 * 避免构建产物中出现 Node fs 模块引用（Obsidian 审核的 Direct Filesystem Access 警告）。
 */
module.exports = {};