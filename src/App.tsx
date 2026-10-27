import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, PointerEvent } from 'react'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Overlay = { id: string; x: number; y: number; width: number; height: number; text: string; fontSize: number }
type DragState = { id: string; offsetX: number; offsetY: number } | null

const newOverlay = (x: number, y: number): Overlay => ({ id: crypto.randomUUID(), x, y, width: 230, height: 42, text: 'Novo texto', fontSize: 18 })

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [overlays, setOverlays] = useState<Overlay[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<DragState>(null)
  const [isRendering, setIsRendering] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const activeOverlay = overlays.find((overlay) => overlay.id === activeId)

  const renderPage = async (bytes: ArrayBuffer, page: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    setIsRendering(true)
    try {
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) })
      const document = await loadingTask.promise
      setPageCount(document.numPages)
      const pdfPage = await document.getPage(page)
      const viewport = pdfPage.getViewport({ scale: 1.45 })
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      setCanvasSize({ width: viewport.width, height: viewport.height })
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
    } catch { setNotice('Não foi possível abrir este PDF. Tente outro arquivo.') } finally { setIsRendering(false) }
  }

  useEffect(() => { if (pdfBytes) { setOverlays([]); setActiveId(null); void renderPage(pdfBytes, pageNumber) } }, [pdfBytes, pageNumber])

  const loadFile = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setNotice('Escolha um arquivo no formato PDF.'); return }
    setNotice(''); setFileName(file.name); setPageNumber(1); setPdfBytes(await file.arrayBuffer())
  }
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = '' }
  const onDrop = (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void loadFile(file) }

  const createExample = async () => {
    const document = await PDFDocument.create(); const page = document.addPage([595.28, 841.89])
    const font = await document.embedFont(StandardFonts.Helvetica); const bold = await document.embedFont(StandardFonts.HelveticaBold)
    page.drawText('PROPOSTA COMERCIAL', { x: 56, y: 770, size: 22, font: bold, color: rgb(.08, .12, .2) })
    page.drawText('Consultoria de produto digital', { x: 56, y: 730, size: 13, font, color: rgb(.25, .29, .38) })
    page.drawText('Cliente: ACME Tecnologia Ltda.', { x: 56, y: 650, size: 14, font }); page.drawText('Valor do projeto: R$ 12.500,00', { x: 56, y: 610, size: 14, font }); page.drawText('Validade da proposta: 30 dias', { x: 56, y: 570, size: 14, font })
    page.drawLine({ start: { x: 56, y: 535 }, end: { x: 540, y: 535 }, thickness: 1, color: rgb(.85, .87, .91) }); page.drawText('Escopo', { x: 56, y: 495, size: 15, font: bold }); page.drawText('Planejamento, interface e implementação da solução.', { x: 56, y: 463, size: 12, font, color: rgb(.25, .29, .38) })
    const bytes = await document.save(); setFileName('proposta-exemplo.pdf'); setPageNumber(1); setPdfBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  }

  const createOverlayAt = (event: PointerEvent<HTMLDivElement>) => {
    if (!canvasSize.width || (event.target as HTMLElement).closest('.text-overlay')) return
    const bounds = event.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(event.clientX - bounds.left - 8, canvasSize.width - 240)); const y = Math.max(0, Math.min(event.clientY - bounds.top - 20, canvasSize.height - 50)); const overlay = newOverlay(x, y)
    setOverlays((items) => [...items, overlay]); setActiveId(overlay.id)
  }
  const updateOverlay = (id: string, changes: Partial<Overlay>) => setOverlays((items) => items.map((item) => item.id === id ? { ...item, ...changes } : item))
  const startDragging = (event: PointerEvent<HTMLDivElement>, id: string) => {
    event.stopPropagation(); const overlay = overlays.find((item) => item.id === id); const bounds = viewerRef.current?.getBoundingClientRect(); if (!overlay || !bounds) return
    setActiveId(id); setDragging({ id, offsetX: event.clientX - bounds.left - overlay.x, offsetY: event.clientY - bounds.top - overlay.y }); event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveOverlay = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !viewerRef.current) return; const bounds = viewerRef.current.getBoundingClientRect(); const overlay = overlays.find((item) => item.id === dragging.id); if (!overlay) return
    updateOverlay(dragging.id, { x: Math.max(0, Math.min(event.clientX - bounds.left - dragging.offsetX, canvasSize.width - overlay.width)), y: Math.max(0, Math.min(event.clientY - bounds.top - dragging.offsetY, canvasSize.height - overlay.height)) })
  }
  const exportPdf = async () => {
    if (!pdfBytes) return; setIsExporting(true)
    try {
      const pdfDocument = await PDFDocument.load(pdfBytes.slice(0)); const page = pdfDocument.getPage(pageNumber - 1); const { width, height } = page.getSize(); const font = await pdfDocument.embedFont(StandardFonts.Helvetica)
      for (const overlay of overlays) { const x = overlay.x * width / canvasSize.width; const boxWidth = overlay.width * width / canvasSize.width; const boxHeight = overlay.height * height / canvasSize.height; const y = height - ((overlay.y + overlay.height) * height / canvasSize.height); const size = overlay.fontSize * width / canvasSize.width; page.drawRectangle({ x, y, width: boxWidth, height: boxHeight, color: rgb(1, 1, 1) }); page.drawText(overlay.text || ' ', { x: x + 5, y: y + (boxHeight - size) / 2 + 1, size, font, color: rgb(.08, .1, .15), maxWidth: Math.max(0, boxWidth - 10) }) }
      const bytes = await pdfDocument.save(); const downloadBytes = new Uint8Array(bytes.length); downloadBytes.set(bytes); const blob = new Blob([downloadBytes.buffer as ArrayBuffer], { type: 'application/pdf' }); const url = URL.createObjectURL(blob); const link = window.document.createElement('a'); link.href = url; link.download = fileName.replace(/\.pdf$/i, '') + '-editado.pdf'; link.click(); URL.revokeObjectURL(url); setNotice('PDF editado baixado com sucesso.')
    } catch { setNotice('Não foi possível exportar o arquivo.') } finally { setIsExporting(false) }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">S</span><span>studio</span><b>PDF</b></div><div className="header-actions"><button className="help-button">?</button><button className="avatar">JD</button></div></header>
    <aside className="sidebar"><button className="new-file" onClick={() => document.getElementById('pdf-input')?.click()}><span>＋</span> Novo arquivo</button><input id="pdf-input" type="file" accept="application/pdf" onChange={handleFile} hidden /><nav><button className="nav-item active"><span>▣</span> Meus documentos</button><button className="nav-item"><span>◷</span> Recentes</button></nav><div className="sidebar-bottom"><div className="secure-note"><span>⌁</span><p><strong>Seus arquivos estão seguros</strong><br />Nada é enviado sem sua permissão.</p></div><button className="nav-item"><span>⚙</span> Configurações</button></div></aside>
    <section className="workspace"><div className="document-bar"><div className="file-title"><span className="file-icon">PDF</span><div><strong>{fileName || 'Documento sem título'}</strong><small>{pdfBytes ? `${pageCount} página${pageCount === 1 ? '' : 's'} · salvo localmente` : 'Faça upload para começar'}</small></div></div><div className="document-actions"><button className="secondary-button" onClick={() => document.getElementById('pdf-input')?.click()}>Trocar PDF</button><button className="export-button" disabled={!pdfBytes || isExporting} onClick={exportPdf}>{isExporting ? 'Preparando...' : '↓ Exportar PDF'}</button></div></div>
      {!pdfBytes ? <section className="welcome-panel"><div className="welcome-copy"><span className="eyebrow">PDF STUDIO</span><h1>Edite o que importa.<br /><i>Sem recomeçar.</i></h1><p>Altere informações do seu PDF em segundos. Cubra o texto original e escreva por cima, direto no navegador.</p><div className="feature-row"><span>✓ PDFs exportados do Word</span><span>✓ Sem instalação</span><span>✓ Download imediato</span></div></div><label className="upload-card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><input type="file" accept="application/pdf" onChange={handleFile} hidden /><div className="upload-symbol">↑</div><strong>Solte seu PDF aqui</strong><p>ou clique para selecionar um arquivo</p><small>PDF de até 25 MB</small></label><button className="example-link" onClick={() => void createExample()}>Abrir um documento de exemplo <span>→</span></button></section> : <section className="editor-layout"><aside className="tool-panel"><div className="tool-heading">FERRAMENTAS</div><button className="tool active"><span>Ｔ</span><span><strong>Texto</strong><small>Clique para adicionar</small></span></button><button className="tool"><span>▱</span><span><strong>Retângulo</strong><small>Cubra uma informação</small></span></button><hr /><div className="tool-heading">DICA RÁPIDA</div><p className="tip">Clique no documento para criar uma caixa. Arraste-a para ajustar a posição.</p></aside><div className="canvas-area"><div className="page-controls"><button disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>‹</button><span>Página {pageNumber} de {pageCount || 1}</span><button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)}>›</button></div><div className="document-scroll"><div ref={viewerRef} className="pdf-viewer" style={{ width: canvasSize.width || undefined, height: canvasSize.height || undefined }} onPointerDown={createOverlayAt} onPointerMove={moveOverlay} onPointerUp={() => setDragging(null)}><canvas ref={canvasRef} />{isRendering && <div className="rendering">Renderizando PDF…</div>}{overlays.map((overlay) => <div key={overlay.id} className={`text-overlay ${activeId === overlay.id ? 'selected' : ''}`} style={{ left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height }} onPointerDown={(event) => startDragging(event, overlay.id)}><input aria-label="Texto de sobreposição" value={overlay.text} onChange={(event) => updateOverlay(overlay.id, { text: event.target.value })} style={{ fontSize: overlay.fontSize }} /></div>)}</div></div></div><aside className="properties-panel">{activeOverlay ? <><div className="properties-title"><span>PROPRIEDADES</span><button onClick={() => { setOverlays((items) => items.filter((item) => item.id !== activeOverlay.id)); setActiveId(null) }}>Excluir</button></div><label>Texto<textarea value={activeOverlay.text} onChange={(event) => updateOverlay(activeOverlay.id, { text: event.target.value })} /></label><label>Tamanho <div className="range-row"><input type="range" min="10" max="36" value={activeOverlay.fontSize} onChange={(event) => updateOverlay(activeOverlay.id, { fontSize: Number(event.target.value) })} /><span>{activeOverlay.fontSize}px</span></div></label><label>Fundo<div className="color-choice"><button className="color-dot white active" /><button className="color-dot cream" /><button className="color-dot gray" /></div></label><div className="property-note">A caixa branca será incorporada ao PDF quando você exportar.</div></> : <div className="empty-properties"><div>Ｔ</div><strong>Selecione uma caixa</strong><p>Crie ou selecione uma caixa de texto para ajustar suas propriedades.</p></div>}</aside></section>}
      {notice && <div className="toast">{notice}<button onClick={() => setNotice('')}>×</button></div>}</section>
  </main>
}
export default App
