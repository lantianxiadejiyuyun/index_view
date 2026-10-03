# 普通首页与桌面网格布局接口

普通首页和桌面复用网格接口，通过 `scope` 区分位置与组件尺寸。接口均要求有效导航站登录；不传 `scope` 时按 `desktop` 处理，兼容旧客户端。

| scope | 设置存储键 | 用途 |
| --- | --- | --- |
| `desktop` | `desktop_layout` | 桌面模式布局 |
| `home` | `home_layout` | 普通首页布局 |

每份布局都保持 `version: 1`，包含互相独立的 `wide`、`compact`。布局不存在时返回空对象，不复制另一模式的坐标。

```json
{
  "layout": {
    "version": 1,
    "wide": { "widget:clock": { "col": 0, "row": 0, "width": 3, "height": 2 } },
    "compact": { "widget:clock": { "col": 0, "row": 4, "width": 4, "height": 2 } }
  }
}
```

## 读取与保存

- `GET /api/desktop/layout?scope=home`：读取普通首页。`scope` 在查询参数中传递。
- `PATCH /api/desktop/layout`：在 JSON 请求体传递 `scope`、`viewport` 和 `placements`。

```json
{
  "scope": "home",
  "viewport": "wide",
  "placements": [
    { "id": "widget:clock", "col": 0, "row": 2, "width": 3, "height": 2 },
    { "id": "site:12", "col": 5, "row": 4 }
  ]
}
```

响应为选定模式的 `{ "layout": ... }`。只传 `col`、`row` 会保留组件此前的宽高。一次请求可以修改多个项目，但不移动未提交的项目；任一项目非法时整批失败，不写入任何位置。

重置只影响指定模式的指定视口：

```json
{ "scope": "home", "viewport": "compact", "reset": true }
```

## 网格与尺寸限制

- `viewport` 只接受 `wide`、`compact`；`scope` 只接受 `desktop`、`home`，非法值返回 HTTP 400。
- 坐标为整数。`wide.col` 为 0–11，`compact.col` 为 0–3，`row` 为 0–10000。
- `width` 与 `height` 必须成对填写，仅 `widget:*` 可使用。宽度范围：宽屏 1–12，窄屏 1–4；高度范围：1–6。
- `site:*` 与 `folder:*` 不接受布局宽高；文件夹尺寸仍由文件夹配置管理。
- 支持全部 10 个小组件：`clock`、`search`、`weather`、`quote`、`workbench`、`calendar`、`lingxi-calendar`、`lingxi-schedule`、`lingxi-deadline`、`lingxi-chat`。
- 客户端负责目标区域的重叠判断；后端只保存合法请求中的指定坐标与尺寸，不做自动排列。
- 老布局只有坐标时继续有效。读取和导入遇到损坏尺寸时保留合法坐标并忽略该尺寸；非法坐标和不存在的项目被忽略。

## 文件夹与图标

`POST /api/desktop/move` 在请求体中传 `scope`。例如从文件夹移出到普通首页：

```json
{
  "scope": "home",
  "viewport": "wide",
  "site_id": 12,
  "folder_id": null,
  "position": { "col": 5, "row": 4 }
}
```

响应为 `{ "layout": ..., "sites": [...] }`，布局来自所选模式。移入文件夹时 `folder_id` 为目标 ID，无需 `position`。文件夹成员关系和站点内容由两种模式共享，坐标独立；数据库写入失败会同时回滚成员变更与布局。

`POST /api/desktop/collect-groups` 整理共享的站点成员关系，不接受或使用布局范围。

## 备份与删除

`GET /api/export` 在 `settings` 中导出 `desktop_layout`、`home_layout` JSON 字符串。`POST /api/import` 同时处理两份布局，并重映射站点和文件夹 ID。

- 替换导入：恢复各自布局；旧备份缺少 `home_layout` 时普通首页为空，桌面照常恢复。
- 合并导入：保留每个模式已有的小组件位置与尺寸，补入缺少的组件；缺少 `home_layout` 的旧备份不改变已有普通首页布局。
- 任一布局 JSON、版本或大小无效，导入在修改站点和设置前返回 HTTP 400。
- 通用 `PUT /api/settings` 不允许直接写入两份布局，必须使用布局接口进行验证。

`POST /api/sites/bulk-delete` 在同一个事务中清理两份布局的已删除图标位置，保留其他图标、文件夹与组件尺寸。响应同时包含 `desktop_layout`、`home_layout` **对象**；客户端应同步更新两份布局缓存。任一布局写入失败时，删除和两份布局全部回滚。
