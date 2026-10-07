import { Code2, Film, Image, ArrowUpRight, LockKeyhole } from 'lucide-react';
import type { Category, Template } from '../types';

const categories: { id: Category; label: string; icon: typeof Image; description: string }[] = [
  { id: 'image', label: '图像创作', icon: Image, description: '将品牌灵感转化为视觉素材' },
  { id: 'video', label: '视频创作', icon: Film, description: '视频生成与剪辑 · 即将开放' },
  { id: 'coding', label: '编码助手', icon: Code2, description: '应用创作与沙箱 · 即将开放' },
];
export function TemplatePicker({ templates, selectedId, loading, onSelect }: {
  templates: Template[]; selectedId: string; loading: boolean; onSelect: (id: string) => void;
}) {
  return <section id="templates" className="template-section" aria-labelledby="templates-title">
    <div className="section-heading"><h2 id="templates-title">选择创作模板</h2><span>从一个好想法开始</span></div>
    <div className="template-grid">
      {categories.map(({ id, label, icon: Icon, description }) => {
        const items = templates.filter(template => template.category === id);
        return (items.length ? items : [{ id: `placeholder-${id}`, name: label, description, category: id, enabled: false, nodes: [] }]).map(template => {
          const available = template.enabled && id === 'image';
          const selected = selectedId === template.id;
          return <button type="button" key={template.id} className={`template-card ${selected ? 'selected' : ''}`} disabled={!available}
            aria-pressed={selected} onClick={() => onSelect(template.id)}>
            <div className="template-top"><span className={`template-icon icon-${id}`}><Icon size={20} /></span>
              {available ? <ArrowUpRight size={18} aria-hidden="true" /> : <span className="coming-soon"><LockKeyhole size={11} />{id === 'image' ? (loading ? '加载中' : '等待服务') : '即将开放'}</span>}
            </div>
            <strong>{template.name}</strong><span className="template-description">{template.description}</span>
            <span className="template-type">{template.source === 'workflow' ? `本地工作流 · 修订 v${template.workflowRevision}` : id === 'image' ? '图像工作流' : label}{selected && <span className="chosen">已选择</span>}</span>
          </button>;
        });
      })}
    </div>
  </section>;
}
