import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, PointerEvent } from 'react'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Overlay = { id: string; x: number; y: number; width: number; height: number; text: string; fontSize: number }
type TextBlock = { id: string; text: string; x: number; y: number; width: number; height: number; fontSize: number }
type PageEdits = Record<number, Overlay[]>
type Metrics = Record<number, { width: number; height: number }>
type Interaction = { type: 'move' | 'resize'; id: string; page: number; startX: number; startY: number; original: Overlay } | null

const cleanEdits: PageEdits = {}
const makeOverlay = (x: number, y: number): Overlay => ({ id: crypto.randomUUID(), x, y, width: 230, height: 42, text: 'Novo texto', fontSize: 18 })

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editsRef = useRef<PageEdits>(cleanEdits)
  const historyRef = useRef<PageEdits[]>([cleanEdits])
  const historyIndexRef = useRef(0)
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [metrics, setMetrics] = useState<Metrics>({})
  const [textBlocks, setTextBlocks] = useState<Record<number, TextBlock[]>>({})
  const [edits, setEdits] = useState<PageEdits>(cleanEdits)
  const [historyIndex, setHistoryIndex] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [interaction, setInteraction] = useState<Interaction>(null)
  const [editMode, setEditMode] = useState<'cover' | 'direct'>('direct')
  const [isRendering, setIsRendering] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const pageOverlays = edits[pageNumber] ?? []
  const pageTextBlocks = textBlocks[pageNumber] ?? []
  const activeOverlay = pageOverlays.find((item) => item.id === activeId)
  const editCount = Object.values(edits).flat().length

  const setWorkingEdits = (next: PageEdits) => { editsRef.current = next; setEdits(next) }
  const recordEdits = (next: PageEdits) => {
    const snapshots = [...historyRef.current.slice(0, historyIndexRef.current + 1), next].slice(-60)
    historyRef.current = snapshots
    historyIndexRef.current = snapshots.length - 1
    setWorkingEdits(next)
    setHistoryIndex(historyIndexRef.current)
  }
  const resetEdits = () => { historyRef.current = [cleanEdits]; historyIndexRef.current = 0; setWorkingEdits(cleanEdits); setHistoryIndex(0) }
  const undo = () => { if (!historyIndexRef.current) return; historyIndexRef.current--; setWorkingEdits(historyRef.current[historyIndexRef.current]); setHistoryIndex(historyIndexRef.current); setActiveId(null) }
  const redo = () => { if (historyIndexRef.current >= historyRef.current.length - 1) return; historyIndexRef.current++; setWorkingEdits(historyRef.current[historyIndexRef.current]); setHistoryIndex(historyIndexRef.current); setActiveId(null) }

  const renderPage = async (bytes: ArrayBuffer, page: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    setIsRendering(true)
    try {
      const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise
      setPageCount(loaded.numPages)
      const pdfPage = await loaded.getPage(page)
      const viewport = pdfPage.getViewport({ scale: 1.45 })
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      setCanvasSize({ width: viewport.width, height: viewport.height })
      setMetrics((current) => ({ ...current, [page]: { width: viewport.width, height: viewport.height } }))
      const content = await pdfPage.getTextContent()
      const blocks = content.items.flatMap((item, index) => {
        const textItem = item as { str?: string; width?: number; transform?: number[] }
        if (!textItem.str?.trim() || !textItem.width || !textItem.transform) return []
        const transform = pdfjsLib.Util.transform(viewport.transform, textItem.transform)
        const fontSize = Math.max(10, Math.hypot(transform[2], transform[3]))
        return [{ id: `${page}-${index}`, text: textItem.str, x: transform[4], y: transform[5] - fontSize, width: Math.max(12, textItem.width * viewport.scale), height: fontSize * 1.25, fontSize }]
      })
      setTextBlocks((current) => ({ ...current, [page]: blocks }))
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
    } catch { setNotice('Não foi possível abrir este PDF. Tente outro arquivo.') } finally { setIsRendering(false) }
  }

  useEffect(() => { if (pdfBytes) { setActiveId(null); setInteraction(null); void renderPage(pdfBytes, pageNumber) } }, [pdfBytes, pageNumber])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
      if ((event.key === 'Backspace' || event.key === 'Delete') && activeId && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) deleteActive()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })

  const resetDocument = (bytes: ArrayBuffer, name: string) => { setNotice(''); setFileName(name); setPageNumber(1); setEditMode('direct'); setMetrics({}); setTextBlocks({}); resetEdits(); setPdfBytes(bytes) }
  const loadFile = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setNotice('Escolha um arquivo no formato PDF.'); return }
    resetDocument(await file.arrayBuffer(), file.name)
  }
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = '' }
  const onDrop = (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void loadFile(file) }
  const createExample = async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([595.28, 841.89])
    const font = await document.embedFont(StandardFonts.Helvetica)
    const bold = await document.embedFont(StandardFonts.HelveticaBold)
    page.drawText('PROPOSTA COMERCIAL', { x: 56, y: 770, size: 22, font: bold, color: rgb(.08, .12, .2) })
    page.drawText('Consultoria de produto digital', { x: 56, y: 730, size: 13, font, color: rgb(.25, .29, .38) })
    page.drawText('Cliente: ACME Tecnologia Ltda.', { x: 56, y: 650, size: 14, font })
    page.drawText('Valor do projeto: R$ 12.500,00', { x: 56, y: 610, size: 14, font })
    page.drawText('Validade da proposta: 30 dias', { x: 56, y: 570, size: 14, font })
    page.drawText('Escopo', { x: 56, y: 495, size: 15, font: bold })
    page.drawText('Planejamento, interface e implementação da solução.', { x: 56, y: 463, size: 12, font, color: rgb(.25, .29, .38) })
    const bytes = await document.save()
    resetDocument(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'proposta-exemplo.pdf')
  }

  const createOverlayAt = (event: PointerEvent<HTMLDivElement>) => {
    if (editMode !== 'cover' || !canvasSize.width || (event.target as HTMLElement).closest('.text-overlay')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const overlay = makeOverlay(Math.max(0, Math.min(event.clientX - bounds.left - 8, canvasSize.width - 240)), Math.max(0, Math.min(event.clientY - bounds.top - 20, canvasSize.height - 50)))
    recordEdits({ ...editsRef.current, [pageNumber]: [...(editsRef.current[pageNumber] ?? []), overlay] })
    setActiveId(overlay.id)
  }
  const updateOverlay = (id: string, changes: Partial<Overlay>, record = true) => {
    const next = { ...editsRef.current, [pageNumber]: (editsRef.current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, ...changes } : item) }
    record ? recordEdits(next) : setWorkingEdits(next)
  }
  const deleteActive = () => { if (!activeId) return; recordEdits({ ...editsRef.current, [pageNumber]: (editsRef.current[pageNumber] ?? []).filter((item) => item.id !== activeId) }); setActiveId(null) }
  const startDirectEdit = (event: PointerEvent<HTMLButtonElement>, block: TextBlock) => {
    event.stopPropagation()
    const existing = (editsRef.current[pageNumber] ?? []).find((item) => item.x === block.x && item.y === block.y && item.text === block.text)
    if (existing) { setActiveId(existing.id); return }
    const overlay: Overlay = { id: crypto.randomUUID(), x: block.x, y: block.y, width: block.width + 8, height: Math.max(28, block.height + 6), text: block.text, fontSize: block.fontSize }
    recordEdits({ ...editsRef.current, [pageNumber]: [...(editsRef.current[pageNumber] ?? []), overlay] })
    setActiveId(overlay.id)
  }
  const startInteraction = (event: PointerEvent<HTMLElement>, id: string, type: 'move' | 'resize') => {
    event.stopPropagation()
    const overlay = (editsRef.current[pageNumber] ?? []).find((item) => item.id === id)
    if (!overlay) return
    setActiveId(id)
    setInteraction({ type, id, page: pageNumber, startX: event.clientX, startY: event.clientY, original: overlay })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveInteraction = (event: PointerEvent<HTMLDivElement>) => {
    if (!interaction || interaction.page !== pageNumber) return
    const dx = event.clientX - interaction.startX; const dy = event.clientY - interaction.startY; const original = interaction.original
    if (interaction.type === 'move') updateOverlay(interaction.id, { x: Math.max(0, Math.min(original.x + dx, canvasSize.width - original.width)), y: Math.max(0, Math.min(original.y + dy, canvasSize.height - original.height)) }, false)
    else updateOverlay(interaction.id, { width: Math.max(80, Math.min(original.width + dx, canvasSize.width - original.x)), height: Math.max(28, Math.min(original.height + dy, canvasSize.height - original.y)) }, false)
  }
  const endInteraction = () => { if (interaction) recordEdits(editsRef.current); setInteraction(null) }
  const exportPdf = async () => {
    if (!pdfBytes) return
    setIsExporting(true)
    try {
      const pdfDocument = await PDFDocument.load(pdfBytes.slice(0))
      const font = await pdfDocument.embedFont(StandardFonts.Helvetica)
      for (const [pageKey, overlays] of Object.entries(editsRef.current)) {
        const index = Number(pageKey); const metric = metrics[index]
        if (!metric || !overlays.length) continue
        const page = pdfDocument.getPage(index - 1); const { width, height } = page.getSize()
        for (const overlay of overlays) {
          const x = overlay.x * width / metric.width; const boxWidth = overlay.width * width / metric.width; const boxHeight = overlay.height * height / metric.height
          const y = height - ((overlay.y + overlay.height) * height / metric.height); const size = overlay.fontSize * width / metric.width
          page.drawRectangle({ x, y, width: boxWidth, height: boxHeight, color: rgb(1, 1, 1) })
          page.drawText(overlay.text || ' ', { x: x + 5, y: y + (boxHeight - size) / 2 + 1, size, font, color: rgb(.08, .1, .15), maxWidth: Math.max(0, boxWidth - 10) })
        }
      }
      const bytes = await pdfDocument.save(); const downloadBytes = new Uint8Array(bytes.length); downloadBytes.set(bytes)
      const url = URL.createObjectURL(new Blob([downloadBytes.buffer as ArrayBuffer], { type: 'application/pdf' }))
      const link = window.document.createElement('a'); link.href = url; link.download = fileName.replace(/\.pdf$/i, '') + '-editado.pdf'; link.click(); URL.revokeObjectURL(url)
      setNotice('PDF editado baixado com sucesso.')
    } catch { setNotice('Não foi possível exportar o arquivo.') } finally { setIsExporting(false) }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">S</span><span>studio</span><b>PDF</b></div><div className="header-actions"><button className="help-button">?</button><button className="avatar">JD</button></div></header>
    <aside className="sidebar"><button className="new-file" onClick={() => document.getElementById('pdf-input')?.click()}><span>＋</span> Novo arquivo</button><input id="pdf-input" type="file" accept="application/pdf" onChange={handleFile} hidden /><nav><button className="nav-item active"><span>▣</span> Meus documentos</button><button className="nav-item"><span>◷</span> Recentes</button></nav><div className="sidebar-bottom"><div className="secure-note"><span>⌁</span><p><strong>Seus arquivos estão seguros</strong><br />Nada é enviado sem sua permissão.</p></div><button className="nav-item"><span>⚙</span> Configurações</button></div></aside>
    <section className="workspace">
      <div className="document-bar"><div className="file-title"><span className="file-icon">PDF</span><div><strong>{fileName || 'Documento sem título'}</strong><small>{pdfBytes ? `${pageCount} página${pageCount === 1 ? '' : 's'} · ${editCount} ${editCount === 1 ? 'alteração local' : 'alterações locais'}` : 'Faça upload para começar'}</small></div></div><div className="document-actions"><button className="secondary-button" onClick={undo} disabled={historyIndex === 0}>↶ Desfazer</button><button className="secondary-button" onClick={redo} disabled={historyIndex >= historyRef.current.length - 1}>↷</button><button className="secondary-button" onClick={() => document.getElementById('pdf-input')?.click()}>Trocar PDF</button><button className="export-button" disabled={!pdfBytes || isExporting} onClick={exportPdf}>{isExporting ? 'Preparando...' : '↓ Exportar PDF'}</button></div></div>
      {!pdfBytes ? <section className="welcome-panel"><div className="welcome-copy"><span className="eyebrow">PDF STUDIO</span><h1>Edite o que importa.<br /><i>Sem recomeçar.</i></h1><p>Altere informações do seu PDF em segundos. Cubra o texto original ou edite um texto detectado, direto no navegador.</p><div className="feature-row"><span>✓ PDFs exportados do Word</span><span>✓ Sem instalação</span><span>✓ Download imediato</span></div></div><label className="upload-card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><input type="file" accept="application/pdf" onChange={handleFile} hidden /><div className="upload-symbol">↑</div><strong>Solte seu PDF aqui</strong><p>ou clique para selecionar um arquivo</p><small>PDF de até 25 MB</small></label><button className="example-link" onClick={() => void createExample()}>Abrir um documento de exemplo <span>→</span></button></section> : <section className="editor-layout">
        <aside className="tool-panel"><div className="tool-heading">FERRAMENTAS</div><button className={`tool ${editMode === 'cover' ? 'active' : ''}`} onClick={() => setEditMode('cover')}><span>Ｔ</span><span><strong>Texto de cobertura</strong><small>Clique para adicionar</small></span></button><button className={`tool ${editMode === 'direct' ? 'active' : ''}`} onClick={() => setEditMode('direct')}><span>⌗</span><span><strong>Edição direta</strong><small>Textos detectados</small></span></button><hr /><div className="tool-heading">DICA RÁPIDA</div><p className="tip">{editMode === 'direct' ? 'Clique em um trecho destacado para alterar o próprio texto. PDFs escaneados não possuem camada de texto.' : 'Clique no documento para criar uma caixa. Arraste a caixa para mover; use o canto inferior direito para redimensionar.'}</p></aside>
        <div className="canvas-area"><div className="page-controls"><button disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>‹</button><span>Página {pageNumber} de {pageCount || 1}</span><button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)}>›</button></div><div className="document-scroll"><div className={`pdf-viewer ${editMode === 'direct' ? 'direct-mode' : ''}`} style={{ width: canvasSize.width || undefined, height: canvasSize.height || undefined }} onPointerDown={createOverlayAt} onPointerMove={moveInteraction} onPointerUp={endInteraction} onPointerCancel={endInteraction}><canvas ref={canvasRef} />{isRendering && <div className="rendering">Renderizando PDF…</div>}{editMode === 'direct' && pageTextBlocks.map((block) => <button key={block.id} className="text-hit" title={`Editar: ${block.text}`} style={{ left: block.x, top: block.y, width: block.width, height: block.height }} onPointerDown={(event) => startDirectEdit(event, block)} />)}{pageOverlays.map((overlay) => <div key={overlay.id} className={`text-overlay ${activeId === overlay.id ? 'selected' : ''}`} style={{ left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height }} onPointerDown={(event) => startInteraction(event, overlay.id, 'move')}><input aria-label="Texto de edição" value={overlay.text} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => updateOverlay(overlay.id, { text: event.target.value })} style={{ fontSize: overlay.fontSize }} /><button className="resize-handle" aria-label="Redimensionar caixa" onPointerDown={(event) => startInteraction(event, overlay.id, 'resize')} /></div>)}</div></div></div>
        <aside className="properties-panel">{activeOverlay ? <><div className="properties-title"><span>PROPRIEDADES</span><button onClick={deleteActive}>Excluir</button></div><label>Texto<textarea value={activeOverlay.text} onChange={(event) => updateOverlay(activeOverlay.id, { text: event.target.value })} /></label><label>Tamanho <div className="range-row"><input type="range" min="10" max="36" value={activeOverlay.fontSize} onChange={(event) => updateOverlay(activeOverlay.id, { fontSize: Number(event.target.value) })} /><span>{Math.round(activeOverlay.fontSize)}px</span></div></label><div className="property-note">O texto ficará visualmente no mesmo lugar ao exportar, preservando o restante da página.</div></> : <div className="empty-properties"><div>Ｔ</div><strong>{editMode === 'direct' ? 'Clique em um texto' : 'Selecione uma caixa'}</strong><p>{editMode === 'direct' ? 'Os trechos com camada de texto ficam prontos para edição.' : 'As alterações ficam guardadas em cada página até o download.'}</p></div>}</aside>
      </section>}
      {notice && <div className="toast">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    </section>
  </main>
}

export default App
