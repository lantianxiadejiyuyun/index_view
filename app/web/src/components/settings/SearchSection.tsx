import { useState } from 'react'
import { Check, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import {
  BUILTIN_ENGINES,
  allEngines,
  parseCustomEngines,
  type SearchEngine,
} from '../../lib/settings.ts'
import { useApp } from '../../store/app.ts'
import { toast } from '../../store/toast.ts'
import { btnGhost, btnPrimary } from '../Modal.tsx'
import { FieldBlock, Note, TextField, inputClass } from './controls.tsx'
import { SettingsSection } from './Section.tsx'
import { useSettingsSave, type SettingsPatch } from './saver.tsx'

type EngineDraft = {
  /** null 表示新增，否则是在改哪一条 */
  id: string | null
  name: string
  url: string
  keyword: string
}

const EMPTY_DRAFT: EngineDraft = { id: null, name: '', url: '', keyword: '' }

/** 自定义引擎的 id 只用于去重和记忆选择，不需要全局唯一性保证，随机串足够 */
function newEngineId(): string {
  return `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function validate(draft: EngineDraft, custom: SearchEngine[]): string | null {
  const name = draft.name.trim()
  const url = draft.url.trim()
  const keyword = draft.keyword.trim()

  if (!name) return '请填写引擎名称'
  if (!/^https?:\/\/\S+$/i.test(url)) return '地址需要以 http:// 或 https:// 开头'
  // 没有 %s 就没法把查询词塞进地址，这是最容易漏的一步，必须硬性拦住
  if (!url.includes('%s')) return '地址里必须包含 %s，它是查询词的占位符'
  if (/\s/.test(keyword)) return '前缀不能包含空格'

  const dupe = custom.find((e) => e.id !== draft.id && e.name.trim() === name)
  if (dupe) return `已经有一个叫「${name}」的引擎了`

  if (keyword) {
    const taken = [...custom, ...BUILTIN_ENGINES].find(
      (e) => e.id !== draft.id && (e.keyword ?? '') === keyword,
    )
    if (taken) return `前缀「${keyword}」已经被「${taken.name}」占用`
  }

  return null
}

export function SearchSection() {
  const settings = useApp((s) => s.settings)
  const { save, readOnly } = useSettingsSave()

  const [draft, setDraft] = useState<EngineDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const custom = parseCustomEngines(settings.custom_engines)
  const engines = allEngines(settings)
  // 引擎可能已被删掉但 search_engine 还指着它，这时下拉框会显示空白，补一条占位项
  const selectedMissing = !engines.some((e) => e.id === settings.search_engine)

  function openEditor(engine: SearchEngine | null) {
    setError(null)
    setDraft(
      engine
        ? { id: engine.id, name: engine.name, url: engine.url, keyword: engine.keyword ?? '' }
        : { ...EMPTY_DRAFT },
    )
  }

  async function submit() {
    if (!draft) return
    const message = validate(draft, custom)
    if (message) {
      setError(message)
      toast.error(message)
      return
    }

    const keyword = draft.keyword.trim()
    const entry: SearchEngine = {
      id: draft.id ?? newEngineId(),
      name: draft.name.trim(),
      url: draft.url.trim(),
    }
    if (keyword) entry.keyword = keyword

    const next = draft.id ? custom.map((e) => (e.id === draft.id ? entry : e)) : [...custom, entry]

    setBusy(true)
    const ok = await save({ custom_engines: JSON.stringify(next) })
    setBusy(false)
    // 失败了就保留表单，用户的输入不能因为一次网络抖动丢掉
    if (!ok) return

    toast.success(draft.id ? '引擎已更新' : '引擎已添加')
    setDraft(null)
    setError(null)
  }

  async function remove(engine: SearchEngine) {
    if (!window.confirm(`删除搜索引擎「${engine.name}」？`)) return

    const patch: SettingsPatch = {
      custom_engines: JSON.stringify(custom.filter((e) => e.id !== engine.id)),
    }
    // 删掉的正好是当前默认引擎：顺手回落到 Bing，否则搜索框会指向一个不存在的引擎
    if (settings.search_engine === engine.id) patch.search_engine = 'bing'

    if (await save(patch)) toast.success('已删除')
  }

  return (
    <SettingsSection id="search" description="默认引擎与自定义引擎；搜索框里输入前缀可临时切换">
      <FieldBlock label="默认搜索引擎" hint="输入「前缀 + 空格 + 关键词」可以临时走别的引擎">
        <select
          className={inputClass}
          value={settings.search_engine}
          disabled={readOnly}
          onChange={(e) => void save({ search_engine: e.target.value })}
        >
          {selectedMissing && (
            <option value={settings.search_engine} className="bg-slate-800">
              {settings.search_engine}（已失效）
            </option>
          )}
          {custom.length > 0 && (
            <optgroup label="自定义">
              {custom.map((e) => (
                <option key={e.id} value={e.id} className="bg-slate-800">
                  {e.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="内置">
            {BUILTIN_ENGINES.map((e) => (
              <option key={e.id} value={e.id} className="bg-slate-800">
                {e.name}
              </option>
            ))}
          </optgroup>
        </select>
      </FieldBlock>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-fg/70">
            自定义引擎
            <span className="ml-1.5 text-fg/40">{custom.length}</span>
          </span>
          {!draft && (
            <button
              type="button"
              className={`${btnGhost} flex items-center gap-1.5 px-3 py-2`}
              disabled={readOnly || custom.length >= 20}
              onClick={() => openEditor(null)}
            >
              <Plus className="size-3.5" aria-hidden />
              添加
            </button>
          )}
        </div>

        {custom.length === 0 && !draft && (
          <p className="rounded-xl border border-dashed border-line/15 px-3 py-4 text-center text-xs text-fg/45">
            还没有自定义引擎。加一个就能用「前缀 + 空格 + 关键词」直达自己的搜索站。
          </p>
        )}

        <ul className="space-y-2">
          {custom.map((engine) => (
            <li
              key={engine.id}
              className="flex items-center gap-2 rounded-xl border border-line/10 bg-line/5 px-3 py-2"
            >
              <Search className="size-4 shrink-0 text-fg/40" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm text-fg/90">
                  <span className="truncate">{engine.name}</span>
                  {engine.keyword && (
                    <span className="shrink-0 rounded-md bg-line/10 px-1.5 py-0.5 font-mono text-[10px] text-fg/60">
                      {engine.keyword}
                    </span>
                  )}
                  {settings.search_engine === engine.id && (
                    <span className="shrink-0 rounded-md bg-brand-500/25 px-1.5 py-0.5 text-[10px] text-accent">
                      默认
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-[11px] text-fg/45">{engine.url}</p>
              </div>

              <button
                type="button"
                aria-label={`编辑 ${engine.name}`}
                title="编辑"
                disabled={readOnly}
                onClick={() => openEditor(engine)}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-fg/60 transition hover:bg-line/15 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Pencil className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`删除 ${engine.name}`}
                title="删除"
                disabled={readOnly}
                onClick={() => void remove(engine)}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-fg/60 transition hover:bg-rose-500/20 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {draft && (
        <div className="animate-pop space-y-3 rounded-xl border border-line/15 bg-line/5 p-3">
          <p className="text-xs font-medium text-fg/80">{draft.id ? '编辑引擎' : '新增引擎'}</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              id="engine-name"
              label="名称"
              value={draft.name}
              onChange={(next) => setDraft({ ...draft, name: next })}
              placeholder="例如：知乎"
              maxLength={20}
            />
            <TextField
              id="engine-keyword"
              label="前缀（可选）"
              value={draft.keyword}
              onChange={(next) => setDraft({ ...draft, keyword: next.replace(/\s/g, '') })}
              placeholder="例如：zh"
              maxLength={8}
              mono
            />
          </div>

          <TextField
            id="engine-url"
            label="搜索地址"
            value={draft.url}
            onChange={(next) => setDraft({ ...draft, url: next })}
            placeholder="https://www.zhihu.com/search?q=%s"
            inputMode="url"
            mono
            hint={
              <>
                把查询词的位置写成 <span className="font-mono text-fg/70">%s</span>，例如
                <span className="ml-1 font-mono text-fg/70">https://www.bing.com/search?q=%s</span>
              </>
            }
          />

          {error && <Note tone="danger">{error}</Note>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={`${btnGhost} flex items-center gap-1.5`}
              onClick={() => {
                setDraft(null)
                setError(null)
              }}
            >
              <X className="size-3.5" aria-hidden />
              取消
            </button>
            <button
              type="button"
              className={`${btnPrimary} flex items-center gap-1.5`}
              disabled={busy}
              onClick={() => void submit()}
            >
              <Check className="size-3.5" aria-hidden />
              保存
            </button>
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-medium text-fg/70">内置引擎</p>
        <div className="flex flex-wrap gap-1.5">
          {BUILTIN_ENGINES.map((e) => (
            <span
              key={e.id}
              className="rounded-lg bg-line/10 px-2 py-1 font-mono text-[11px] text-fg/55"
            >
              {e.name}
              {e.keyword ? ` · ${e.keyword}` : ''}
            </span>
          ))}
        </div>
      </div>
    </SettingsSection>
  )
}
