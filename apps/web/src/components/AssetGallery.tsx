import { useEffect, useRef, useState } from 'react';
import { Download, Expand, ImageOff, Images, X } from 'lucide-react';
import { assetUrl } from '../api';
import type { Asset } from '../types';

function AssetImage({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  let url: string | undefined;
  try { url = assetUrl(asset.url); } catch { url = undefined; }
  return failed || !url ? <div className="image-failure"><ImageOff size={25} /><span>预览暂不可用</span></div> :
    <img src={url} alt={`${asset.name}，模拟演示素材`} width={asset.width} height={asset.height} loading="lazy" onError={() => setFailed(true)} />;
}
export function AssetGallery({ assets }: { assets: Asset[] }) {
  const [preview, setPreview] = useState<Asset | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const assetRunId = assets[0]?.runId || '';
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (preview) dialog.current?.showModal(); else dialog.current?.close(); }, [preview]);
  useEffect(() => { setPreview(null); setError(null); controller.current?.abort(); setDownloading(null); }, [assetRunId]);
  const download = async (asset: Asset) => {
    if (downloading) return;
    const current = new AbortController(); controller.current = current;
    setDownloading(asset.id); setError(null);
    try {
      const response = await fetch(assetUrl(asset.url), { signal: current.signal });
      if (!response.ok) throw new Error(`下载失败（${response.status}），请稍后重试。`);
      const blob = await response.blob();
      if (current.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = asset.name;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!current.signal.aborted) setError((failure as Error).message || '下载失败，请检查服务连接。'); }
    finally { if (!current.signal.aborted) setDownloading(null); }
  };
  return <section className="panel gallery-panel" aria-labelledby="gallery-title">
    <div className="section-heading"><h2 id="gallery-title"><Images size={18} /> 生成资产</h2><span>{assets.length} 个素材</span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {assets.length === 0 ? <div className="gallery-empty"><div className="empty-icon"><Images size={28} /></div><h3>灵感即将成为作品</h3><p>开始一次创作，完成的素材会出现在这里。<br />执行期间也可以查看已产出的素材。</p><span className="empty-pills"><span>可预览</span><span>可下载</span><span>本地模拟</span></span></div> :
      <div className="asset-grid">{assets.map(asset => <article key={asset.id} className="asset-card">
        <button type="button" className="asset-preview" aria-label={`预览 ${asset.name}`} onClick={() => setPreview(asset)}><AssetImage asset={asset} /><span className="preview-expand"><Expand size={16} /></span><span className="asset-mock">模拟素材</span></button>
        <div className="asset-details"><strong title={asset.name}>{asset.name}</strong><span>{asset.width} × {asset.height} · {asset.mimeType.split('/')[1]?.toUpperCase()}</span>
          <button type="button" className="download-button" disabled={downloading !== null} onClick={() => void download(asset)} aria-label={`下载 ${asset.name}`}><Download size={15} />{downloading === asset.id ? '下载中…' : '下载素材'}</button>
        </div>
      </article>)}</div>}
    <dialog ref={dialog} className="preview-dialog" onCancel={() => setPreview(null)} onClose={() => setPreview(null)} aria-labelledby="preview-title">
      {preview && <><div className="preview-heading"><h3 id="preview-title">{preview.name}</h3><button autoFocus type="button" className="icon-button" onClick={() => setPreview(null)} aria-label="关闭预览"><X size={20} /></button></div><AssetImage asset={preview} /><p className="muted small">本地模拟素材 · 非真实 AI 生成</p></>}
    </dialog>
  </section>;
}
