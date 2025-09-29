# Legacy Templates

`fancoolindex_original.html` 为最初未拆分的大模板，仅在 Stage A 拆分 / 结构对照期间保留。

保留目的：
- 回溯拆分前的 DOM / 样式 / 变量命名
- 避免遗漏尚未迁移的交互逻辑
- 需要快速对比拆分后页面表现差异时参考

使用约定：
- 不再在运行页面中 include
- 不新增逻辑或样式到该文件
- 完成 Stage A 回归并稳定后删除（或以压缩摘要形式存档）

后续计划：
- Stage B：若仍有个别样式尚未抽象，会单独列入 components.css 或 layout.css 后删除该文件
- Stage C：在 README 中补充“历史结构演进”章节后最终移除

(请勿修改此文件除非是更新存档策略说明)
