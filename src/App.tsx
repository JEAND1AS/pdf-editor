import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, PointerEvent } from 'react'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

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

  const subtleButton = 'rounded-md border border-[#dedee4] bg-white px-3.5 py-2.5 text-xs font-bold text-[#666771] transition hover:border-[#b8b1dc] hover:bg-[#faf9ff] disabled:cursor-not-allowed disabled:opacity-40'
  const navItem = 'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] font-semibold text-[#6d6e77] transition hover:bg-[#f8f7fc]'

  return <main className="min-h-screen min-w-[320px] bg-[#f6f7f8] font-sans text-[#202124]">
    <header className="fixed inset-x-0 top-0 z-40 flex h-[72px] items-center justify-between border-b border-[#e9e9eb] bg-white px-4 sm:px-8">
      <div className="flex items-center gap-1 text-xl font-extrabold tracking-[-.9px] text-[#151724]"><span className="mr-1 grid size-7 place-items-center rounded-[9px_9px_9px_2px] bg-[#7658e8] font-serif text-[17px] font-normal text-white">S</span><span>studio</span><b className="ml-0.5 text-[#7658e8]">PDF</b></div>
      <div className="flex items-center gap-[18px]"><button className="grid size-7 place-items-center rounded-full border border-[#dedee4] bg-white text-sm text-[#5c5d64]" aria-label="Ajuda">?</button><button className="size-[33px] rounded-full border-0 bg-[#2b695f] text-[11px] font-extrabold text-white">JD</button></div>
    </header>

    <aside className="fixed bottom-0 left-0 top-[72px] z-30 hidden w-[238px] flex-col border-r border-[#e9e9eb] bg-white px-3.5 pb-[18px] pt-6 md:flex md:w-[68px] md:px-2 lg:w-[238px] lg:px-3.5">
      <button className="w-full rounded-[9px] border-0 bg-[#7658e8] px-3 py-3 text-[13px] font-bold text-white shadow-[0_6px_13px_#7658e828] transition hover:bg-[#6749d8] md:h-[42px] md:text-[0px] lg:h-auto lg:text-[13px]" onClick={() => document.getElementById('pdf-input')?.click()}><span className="mr-1.5 text-xl leading-none align-[-2px] md:mr-0 md:text-[23px] lg:mr-1.5 lg:text-xl">＋</span> Novo arquivo</button>
      <input id="pdf-input" type="file" accept="application/pdf" onChange={handleFile} hidden />
      <nav className="mt-7"><button className={`${navItem} bg-[#f1edff] text-[#4e3db0] md:px-[11px] md:text-[0px] lg:px-3 lg:text-[13px]`}><span className="text-[17px] text-[#7658e8] md:text-[19px] lg:text-[17px]">▣</span> Meus documentos</button><button className={`${navItem} md:px-[11px] md:text-[0px] lg:px-3 lg:text-[13px]`}><span className="text-[17px] text-[#8d8e96] md:text-[19px] lg:text-[17px]">◷</span> Recentes</button></nav>
      <div className="mt-auto"><div className="mx-1 mb-3.5 flex gap-2 rounded-lg bg-[#f8f8fb] p-3 text-[#8a8b91] lg:flex md:hidden"><span className="text-lg text-[#7658e8]">⌁</span><p className="text-[9px] leading-[1.45]"><strong className="text-[10px] text-[#5a5b62]">Seus arquivos estão seguros</strong><br />Nada é enviado sem sua permissão.</p></div><button className={`${navItem} md:px-[11px] md:text-[0px] lg:px-3 lg:text-[13px]`}><span className="text-[17px] text-[#8d8e96] md:text-[19px] lg:text-[17px]">⚙</span> Configurações</button></div>
    </aside>

    <section className="min-h-screen pt-[72px] md:ml-[68px] lg:ml-[238px]">
      <div className="flex min-h-[78px] items-center justify-between gap-2 border-b border-[#e9e9eb] bg-white px-4 sm:px-[31px]">
        <div className="flex items-center gap-2.5"><span className="rounded bg-[#fff0f0] px-1 py-[7px] font-mono text-[8px] font-bold text-[#f05f62]">PDF</span><div><strong className="block text-[13px]">{fileName || 'Documento sem título'}</strong><small className="mt-0.5 hidden text-[10px] text-[#999aa2] sm:block">{pdfBytes ? `${pageCount} página${pageCount === 1 ? '' : 's'} · ${editCount} ${editCount === 1 ? 'alteração local' : 'alterações locais'}` : 'Faça upload para começar'}</small></div></div>
        <div className="flex gap-2.5"><button className={`${subtleButton} hidden sm:block`} onClick={undo} disabled={historyIndex === 0}>↶ Desfazer</button><button className={`${subtleButton} hidden sm:block`} onClick={redo} disabled={historyIndex >= historyRef.current.length - 1}>↷</button><button className={`${subtleButton} hidden sm:block`} onClick={() => document.getElementById('pdf-input')?.click()}>Trocar PDF</button><button className="rounded-md border border-[#7658e8] bg-[#7658e8] px-3.5 py-2.5 text-xs font-bold text-white transition hover:bg-[#6749d8] disabled:cursor-not-allowed disabled:opacity-45" disabled={!pdfBytes || isExporting} onClick={exportPdf}>{isExporting ? 'Preparando...' : '↓ Exportar PDF'}</button></div>
      </div>

      {!pdfBytes ? <section className="mx-auto grid max-w-[1040px] grid-cols-1 items-center gap-[54px] px-8 py-[clamp(45px,9vh,125px)] md:grid-cols-[1.1fr_.9fr] md:px-[50px]">
        <div><span className="font-mono text-[10px] font-medium tracking-[1.2px] text-[#7658e8]">PDF STUDIO</span><h1 className="my-[14px] mb-5 text-[clamp(34px,4.4vw,58px)] font-extrabold leading-[1.05] tracking-[-3px] text-[#20212c]">Edite o que importa.<br /><i className="font-serif font-semibold text-[#7658e8]">Sem recomeçar.</i></h1><p className="max-w-[470px] text-sm leading-[1.8] text-[#71727b]">Altere informações do seu PDF em segundos. Cubra o texto original ou edite um texto detectado, direto no navegador.</p><div className="mt-[26px] flex flex-wrap gap-[15px] text-[10px] font-bold text-[#50515c]"><span>✓ PDFs exportados do Word</span><span>✓ Sem instalação</span><span>✓ Download imediato</span></div></div>
        <label className="flex min-h-[285px] cursor-pointer flex-col items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-[#bcb6db] bg-white shadow-[0_16px_35px_#352b6020] transition hover:-translate-y-0.5 hover:border-[#7658e8]" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><input type="file" accept="application/pdf" onChange={handleFile} hidden /><div className="mb-4 grid size-11 place-items-center rounded-[13px] bg-[#f0ecff] text-2xl text-[#7658e8]">↑</div><strong className="text-sm">Solte seu PDF aqui</strong><p className="my-1.5 mb-[17px] text-[11px] text-[#8f9099]">ou clique para selecionar um arquivo</p><small className="text-[9px] text-[#b1b2b9]">PDF de até 25 MB</small></label>
        <button className="text-left text-[11px] font-bold text-[#6c55cf] md:col-start-2 md:-mt-[37px]" onClick={() => void createExample()}>Abrir um documento de exemplo <span className="pl-1 text-base">→</span></button>
      </section> : <section className="grid h-[calc(100vh-150px)] grid-cols-1 md:grid-cols-[150px_1fr] lg:grid-cols-[190px_1fr_235px]">
        <aside className="hidden border-r border-[#e9e9eb] bg-white px-[15px] py-[23px] md:block"><div className="mx-2 mb-4 font-mono text-[10px] font-medium tracking-[1.2px] text-[#7658e8]">FERRAMENTAS</div><button className={`flex w-full items-center gap-3 rounded-md p-2 text-left ${editMode === 'cover' ? 'bg-[#f1edff]' : ''}`} onClick={() => setEditMode('cover')}><span className={`w-5 text-center text-lg ${editMode === 'cover' ? 'text-[#624bc7]' : 'text-[#777782]'}`}>Ｔ</span><span><strong className={`block text-[11px] ${editMode === 'cover' ? 'text-[#624bc7]' : 'text-[#464750]'}`}>Texto de cobertura</strong><small className="mt-0.5 block text-[9px] text-[#9899a1]">Clique para adicionar</small></span></button><button className={`flex w-full items-center gap-3 rounded-md p-2 text-left ${editMode === 'direct' ? 'bg-[#f1edff]' : ''}`} onClick={() => setEditMode('direct')}><span className={`w-5 text-center text-lg ${editMode === 'direct' ? 'text-[#624bc7]' : 'text-[#777782]'}`}>⌗</span><span><strong className={`block text-[11px] ${editMode === 'direct' ? 'text-[#624bc7]' : 'text-[#464750]'}`}>Edição direta</strong><small className="mt-0.5 block text-[9px] text-[#9899a1]">Textos detectados</small></span></button><hr className="my-[23px] h-px border-0 bg-[#ededf0]" /><div className="mx-2 mb-4 font-mono text-[10px] font-medium tracking-[1.2px] text-[#7658e8]">DICA RÁPIDA</div><p className="px-2 text-[10px] leading-[1.65] text-[#8e8f97]">{editMode === 'direct' ? 'Clique em um trecho destacado para alterar o próprio texto. PDFs escaneados não possuem camada de texto.' : 'Clique no documento para criar uma caixa. Arraste a caixa para mover; use o canto inferior direito para redimensionar.'}</p></aside>
        <div className="flex min-w-0 flex-col bg-[#eceef1]"><div className="flex h-[49px] items-center justify-center gap-[13px] text-[10px] text-[#85868f]"><button className="size-[23px] rounded border border-[#d4d5da] bg-white text-[#676870] disabled:opacity-45" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>‹</button><span>Página {pageNumber} de {pageCount || 1}</span><button className="size-[23px] rounded border border-[#d4d5da] bg-white text-[#676870] disabled:opacity-45" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)}>›</button></div><div className="flex flex-1 justify-start overflow-auto px-3 pb-[22px] md:justify-center md:px-7 md:pb-[35px]"><div className="relative flex-none cursor-text bg-white shadow-[0_3px_14px_#56606c29]" style={{ width: canvasSize.width || undefined, height: canvasSize.height || undefined }} onPointerDown={createOverlayAt} onPointerMove={moveInteraction} onPointerUp={endInteraction} onPointerCancel={endInteraction}><canvas ref={canvasRef} className="block" />{isRendering && <div className="absolute inset-0 grid place-items-center bg-white/80 text-xs text-[#6d5ac3]">Renderizando PDF…</div>}{editMode === 'direct' && pageTextBlocks.map((block) => <button key={block.id} className="absolute rounded-sm border border-dashed border-[#7658e875] bg-[#7658e817] p-0 hover:border-solid hover:border-[#7658e8] hover:bg-[#7658e833]" title={`Editar: ${block.text}`} style={{ left: block.x, top: block.y, width: block.width, height: block.height }} onPointerDown={(event) => startDirectEdit(event, block)} />)}{pageOverlays.map((overlay) => <div key={overlay.id} className={`absolute bg-white p-0 ${activeId === overlay.id ? 'border-[1.5px] border-[#7658e8] shadow-[0_0_0_3px_#7658e833]' : 'border border-transparent'} cursor-grab`} style={{ left: overlay.x, top: overlay.y, width: overlay.width, height: overlay.height }} onPointerDown={(event) => startInteraction(event, overlay.id, 'move')}><input aria-label="Texto de edição" className="size-full border-0 bg-white px-[5px] font-sans text-[#20212c] outline-none" value={overlay.text} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => updateOverlay(overlay.id, { text: event.target.value })} style={{ fontSize: overlay.fontSize }} />{activeId === overlay.id && <button className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-[3px] border-2 border-white bg-[#7658e8] p-0" aria-label="Redimensionar caixa" onPointerDown={(event) => startInteraction(event, overlay.id, 'resize')} />}</div>)}</div></div></div>
        <aside className="hidden border-l border-[#e9e9eb] bg-white px-[15px] py-[23px] lg:block">{activeOverlay ? <><div className="mb-[19px] flex items-center justify-between border-b border-[#eeeef1] px-0.5 pb-[19px] font-mono text-[10px] font-medium tracking-[1px] text-[#74757d]"><span>PROPRIEDADES</span><button className="font-sans text-[10px] font-medium text-[#d06971]" onClick={deleteActive}>Excluir</button></div><label className="mb-5 block text-[10px] font-bold text-[#7c7d86]">Texto<textarea className="mt-2 block min-h-[75px] w-full resize-y rounded-md border border-[#dedee5] p-2 font-sans text-[11px] text-[#383943] outline-[#7658e8]" value={activeOverlay.text} onChange={(event) => updateOverlay(activeOverlay.id, { text: event.target.value })} /></label><label className="mb-5 block text-[10px] font-bold text-[#7c7d86]">Tamanho <div className="mt-[7px] flex items-center gap-2.5"><input className="w-[150px] accent-[#7658e8]" type="range" min="10" max="36" value={activeOverlay.fontSize} onChange={(event) => updateOverlay(activeOverlay.id, { fontSize: Number(event.target.value) })} /><span className="text-[10px] font-medium text-[#757680]">{Math.round(activeOverlay.fontSize)}px</span></div></label><div className="mt-[30px] rounded-md bg-[#f7f6fb] p-[11px] text-[9px] leading-[1.55] text-[#898992]">O texto ficará visualmente no mesmo lugar ao exportar, preservando o restante da página.</div></> : <div className="pt-[110px] text-center"><div className="mb-[13px] text-[25px] text-[#cbc7de]">Ｔ</div><strong className="text-[11px] text-[#71727b]">{editMode === 'direct' ? 'Clique em um texto' : 'Selecione uma caixa'}</strong><p className="mt-2 text-[9px] leading-[1.6] text-[#a1a2aa]">{editMode === 'direct' ? 'Os trechos com camada de texto ficam prontos para edição.' : 'As alterações ficam guardadas em cada página até o download.'}</p></div>}</aside>
      </section>}
      {notice && <div className="fixed bottom-[25px] right-[27px] z-50 rounded-lg bg-[#272830] px-[15px] py-3 text-[11px] text-white shadow-[0_10px_25px_#0003]">{notice}<button className="ml-[15px] border-0 bg-transparent text-base text-[#aaa]" onClick={() => setNotice('')}>×</button></div>}
    </section>
  </main>
}

export default App
