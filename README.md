# 风扇库后端拆分说明

## 目标
- 拆分大单文件，提升可维护性
- 服务层与仓储解耦
- 分享令牌加入过期控制与版本管理
- 保持前端接口兼容（无需前端大改）

## 主要模块
- app/config.py: 配置
- app/extensions.py: SQLAlchemy Engine
- app/security/: UID Cookie 与分享签名
- app/repositories/: 数据访问
- app/services/: 业务逻辑（状态、搜索、点赞、分享、查询日志）
- app/routes/: 蓝图（核心 / 搜索 / 点赞 / 分享 / 杂项 / UI）
- app/background/tasks.py: 查询次数缓存线程
- run.py: 启动

## 分享令牌
结构： base64url(JSON{v, iat, exp, data}) + HMAC 16 hex  
默认有效期 7 天，可通过环境变量 `SHARE_TOKEN_EXPIRE_SECONDS` 调整。

## 前端兼容
所有旧端点保留：
- /api/state /api/add_fan /api/remove_fan /api/restore_fan /api/clear_all
- /api/search_fans
- /api/like /api/unlike /api/recent_likes /api/top_ratings
- /search_models /get_models /get_resistance_types /get_resistance_locations /get_resistance_locations_by_type
- /api/query_count /api/theme /api/config
- /api/create_share /share/<token>

前端仅在想显示“分享过期”时可根据 400 返回文案提示用户。

## 可选前端微调（非必须）
在打开分享失败时展示 toast：
```js
// 例如检测到响应 status 400 时
```

## 测试建议
1. 启动后访问 `/`，确认无 500
2. 添加/移除/恢复/清空风扇
3. 搜索、级联下拉、型号关键字搜索
4. 点赞 / 取消点赞 / 最近点赞 / 好评榜
5. 创建分享并用浏览器打开
6. 查询次数展示变化（每分钟更新）
7. 主题切换 & 会话持久化

## 未来优化
- 引入 pydantic 进行 payload 校验
- 引入 Alembic 管理 schema
- 增加缓存层（Redis）以降低热门榜单查询压力
- 提供 OpenAPI 文档