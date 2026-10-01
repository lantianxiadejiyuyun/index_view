import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Category } from '../lib/types.ts'
import { useApp } from '../store/app.ts'
import { toast } from '../store/toast.ts'
import { Modal, btnGhost, btnPrimary, fieldClass, labelClass } from './Modal.tsx'
import { errorMessage } from '../lib/api.ts'

type Props = {
  open: boolean
  category: Category | null
  onClose: () => void
}

export function CategoryEditorModal({ open, category, onClose }: Props) {
  const createCategory = useApp((s) => s.createCategory)
  const updateCategory = useApp((s) => s.updateCategory)

  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setName(category?.name ?? '')
  }, [open, category])

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('分组名称不能为空')
      return
    }
    setSaving(true)
    try {
      if (category) {
        await updateCategory(category.id, { name: trimmed })
        toast.success('已保存')
      } else {
        await createCategory(trimmed)
        toast.success('分组已创建')
      }
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={category ? '重命名分组' : '新建分组'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} className={btnGhost}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={saving} className={btnPrimary}>
            {saving && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            保存
          </button>
        </>
      }
    >
      <label className={labelClass} htmlFor="ce-name">
        分组名称
      </label>
      <input
        id="ce-name"
        className={fieldClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder="例如：常用、工具、内网服务"
        maxLength={60}
        autoFocus
      />
    </Modal>
  )
}
