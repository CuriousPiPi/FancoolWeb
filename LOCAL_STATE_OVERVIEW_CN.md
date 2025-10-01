# 本地状态改造总览 (Local State Overhaul Overview)

> 目标：除“日志/点赞统计”外，其余交互状态全部前端本地化；服务端仅负责曲线原始数据、统计与分享快照。下表列出需执行的前端(F-)与后端(B-)任务，以及迁移/测试/监控等支持项。
> 优先级：P1 = 首批必须；P2 = 第二阶段；P3 = 可择机优化。

## 1. 总览任务表

| 编号 | 类型 | 优先级 | 任务 | 描述 / 产出 | 关键点 | 依赖 |
|------|------|--------|------|------------|--------|------|
| F-01 | 前端 | P1 | 移除旧 patchSelectedFans / processState 注入逻辑 | 不再消费服务器 selected_fans / recently_removed_fans；改为本地 selectionStore | 删除巨石状态函数 | 无 |
| F-02 | 前端 | P1 | 去除 recently_removed_fans 服务端依赖 | 本地 removedStore（环形队列）管理最近移除 | MAX=30 可配置 | F-01 |
| F-03 | 前端 | P1 | 本地状态模块化 localStores.js | selectionStore / removedStore / shareMetaStore / colorStore / likeStore | localStorage + 内存 | F-01 |
| F-04 | 前端 | P1 | 初始化流程改造 | 启动：读本地 selection -> 调 /api/fans_data 获取曲线 -> 渲染 | 无 /api/state | B-03 |
| F-05 | 前端 | P1 | 序列化版本控制 | fc_data_schema_version=1；不兼容清空旧结构 | 统一迁移入口 | F-03 |
| F-06 | 前端 | P1 | 本地化 add/remove/restore/clear | 仅改本地 store & 增量曲线数据请求 | 乐观立即更新 UI | F-03, B-03 |
| F-07 | 前端 | P1 | 最近移除实现 | removedStore.push(entry)；entry 含 meta | 单条 summary 缓存 | F-03, B-03/B-04 |
| F-08 | 前端 | P1 | 点赞逻辑保留 API + 乐观 | like/unlike 仍调后端；本地 likeStore 缓存 | 周期刷新 bulk | B-05 |
| F-09 | 前端 | P1 | 分享加载与导入重构 | share_snapshot 只读预览；导入按钮合并/替换 selection | 不自动覆盖本地 | B-06, B-07 |
| F-10 | 前端 | P2 | 颜色映射简化 | hash/顺序分配；移除 share_meta.color_indices | 不再 patch color | F-03 |
| F-11 | 前端 | P2 | chart_data 构建解耦 | 本地组装 series 后 postChartData | 过滤逻辑保留 | B-03 |
| F-12 | 前端 | P2 | 模块事件化 | 用事件/订阅替代 processState | 降耦合 | F-01 |
| F-13 | 前端 | P2 | 排行/最近点赞独立 | 进入 tab 时拉取；与 selection 解耦 | 懒加载 | 现有接口 |
| F-14 | 前端 | P3 | 本地数据导出/导入 | 备份 JSON / 调试 | 便于迁移 | F-03 |
| F-15 | 前端 | P3 | 架构文档 | ARCHITECTURE_LOCAL_STATE.md | 团队知识 | 全部 |
| B-01 | 后端 | P1 | 下线 /api/state | 返回简化或 410；前端不再调用 | 防混用 | F-04 |
| B-02 | 后端 | P1 | 保留点赞/排行/最近点赞接口 | /api/like /api/unlike /api/top_ratings /api/recent_likes | 统计仍服务端 | - |
| B-03 | 后端 | P1 | 新增 /api/fans_data | 批量返回曲线+基础 meta（可选） | pairs=mid:cid,... | - |
| B-04 | 后端 | P1 | （可选）/api/fan_summary | 仅返回品牌/型号/场景等元信息 | 可并入 B-03 | - |
| B-05 | 后端 | P2 | /api/bulk_like_keys | 批量返回当前用户已点赞 keys | 减少多请求 | - |
| B-06 | 后端 | P2 | /api/share_snapshot | 返回分享快照 pairs + meta | 只读 | - |
| B-07 | 后端 | P2 | /api/create_share | 输入本地 selection + meta 生成 share_id | 按需压缩 | - |
| B-08 | 后端 | P2 | 移除 recently_removed_fans 概念 | 不再计算/返回 | 与 F-02 一致 | F-02 |
| B-09 | 后端 | P3 | /api/fans_data ETag 缓存 | If-None-Match 支持 | 节省带宽 | B-03 |
| B-10 | 后端 | P3 | 热门曲线缓存 | Redis / 内存 LRU | 热点加速 | B-03 |
| MIG-01 | 迁移 | P1 | localStorage 版本迁移 | 旧 key 清理 -> 新结构 | 启动检测 | F-05 |
| MIG-02 | 迁移 | P1 | 旧选中迁移脚本 | 将旧 window 状态写入 selectionStore | 一次性 | F-04 |
| QA-01 | 测试 | P1 | 基础回归用例 | 空/损坏存储、添加、移除、恢复、清空、分享导入 | 自动化脚本 | F/B 基础 |
| QA-02 | 测试 | P2 | 性能与批量 | 50+ fans 批量加载耗时 | KPI: <2s 首屏 | B-03 |
| OBS-01 | 监控 | P2 | fans_data 指标 | QPS / 平均字节 / 错误率 | Prometheus | B-03 |

## 2. 本地存储 Key 规划
| Key | 用途 | 结构 | 版本策略 |
|-----|------|------|-----------|
| fc_data_schema_version | 结构版本号 | 字符串 '1' | 不同即清空迁移 |
| fc_selected_v1 | 已选列表 | [{model_id,condition_id}] | 未来字段扩展需迁移脚本 |
| fc_removed_v1 | 最近移除 | [{key, model_id, condition_id, brand, model, res_type, res_loc, removed_at}] | 环形截断保持长度 |
| fc_share_meta_v1 | 分享/显示偏好 | {show_raw_curves,...} | 迁移时浅合并默认值 |
| fc_color_map_v1 | 颜色索引(可选) | { key: colorIndex } | 可弃用改 hash |
| fc_like_keys_cache_v1 | 已点赞缓存 | [ 'mid_cid', ... ] | 周期刷新覆盖 |

## 3. 事件流（示意）
``
UI交互(add/remove) -> selectionStore 变更 -> (新增 keys) 调 fans_data 增量拉取 -> assemble chartData -> postChartData -> rebuildSelectedFans
remove -> selectionStore.remove + removedStore.push -> rebuildRemovedFans
share 导入 -> selectionStore.replace / merge -> 批量 fans_data -> 重绘
like/unlike -> 乐观更新 likeStore -> 调 /api/like -> 周期 bulk 校正
``

## 4. 后端接口一览（改造后）
| 接口 | 方法 | 说明 | 备注 |
|------|------|------|------|
| /api/fans_data?pairs= | GET | 批量曲线+元信息 | 主数据源 |
| /api/like | POST | 点赞 | 统计 + 防刷 |
| /api/unlike | POST | 取消点赞 | 同上 |
| /api/top_ratings | GET | 点赞排行 | 现有保留 |
| /api/recent_likes | GET | 最近点赞 | 现有保留 |
| /api/bulk_like_keys | GET | （可选）批量拉取已点赞 | 减网络往返 |
| /api/share_snapshot?share_id= | GET | 分享快照 | 只读 |
| /api/create_share | POST | 生成分享 | 输入 pairs + meta |
| /api/log_query | POST | （可选）记录查询日志 | 仅统计，用于现有日志体系 |

## 5. 渐进实施建议
1. 第 1 周：完成 F-01~F-06, B-01, B-03, MIG-01/02 基本跑通。 
2. 第 2 周：接入分享重构 (F-09, B-06, B-07) 与颜色简化 (F-10)。
3. 第 3 周：批量点赞优化 / 文档 / 缓存 (F-11~13, B-05, B-08)。
4. 第 4 周：可选性能与观测 (B-09, B-10, QA-02, OBS-01)。

## 6. 失败/回滚策略
| 场景 | 处理 |
|------|------|
| 粗暴清空 localStorage 后界面空白 | 自动检测无 selection -> 显示引导添加 | 
| fans_data 部分失败 | 仅跳过失败条目，提示重试 | 
| 点赞接口失败 | 回滚本地点亮状态并提示 | 
| 分享导入失败 | 不修改现有 selection，toast 提示 | 
| 版本迁移异常 | 清空所有 fc_* key 后重置 | 

## 7. 后续可拓展
- 支持“本地方案收藏”列表 (另一个 localStorage key)
- 基于 Web Worker 的曲线预处理（平滑/拟合）
- 增量缓存 fans_data（ETag 命中直接 304）
- 离线模式（已缓存曲线可离线展示）

---
> 本文件为实施参照，不是最终技术规范；执行过程中如需增删任务请在 PR 中同步修改此表.