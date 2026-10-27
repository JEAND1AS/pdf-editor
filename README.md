# PDF Studio

Um editor de PDF no navegador para fazer ajustes rápidos sem precisar instalar um programa. Carregue um PDF, edite textos detectados ou adicione uma caixa de cobertura e baixe uma nova versão do arquivo.

![Prévia do PDF Studio](docs/images/pdf-studio-editor.png)

## O que ele faz

- Abre arquivos PDF diretamente no navegador.
- Navega entre as páginas do documento.
- Detecta a camada de texto de PDFs digitais para iniciar uma edição no mesmo ponto da página.
- Permite criar caixas de texto de cobertura, mover, redimensionar e alterar o tamanho da fonte.
- Mantém um histórico local de desfazer/refazer durante a sessão.
- Exporta uma cópia editada para download.
- Oferece um documento de exemplo para experimentar a interface.

> Os arquivos permanecem no navegador durante o uso: o projeto não envia PDFs para um servidor.

## Tecnologias

| Tecnologia | Uso |
| --- | --- |
| React + TypeScript | Interface e lógica da aplicação |
| Vite | Ambiente de desenvolvimento e build |
| Tailwind CSS 4 | Estilos utilitários e responsividade |
| PDF.js | Renderização e leitura da camada de texto |
| pdf-lib | Geração do PDF exportado |

## Como executar

Pré-requisito: Node.js 20 ou superior.

```bash
npm install
npm run dev
```

Depois, abra a URL exibida pelo Vite (normalmente `http://localhost:5173`). Para criar a versão de produção:

```bash
npm run build
```

## Como editar um PDF

1. Clique em **Novo arquivo** ou solte um arquivo PDF na área de upload.
2. Escolha **Edição direta** e clique em um trecho destacado para trocar seu conteúdo.
3. Se o PDF não tiver texto selecionável, escolha **Texto de cobertura** e clique na página para adicionar uma caixa sobre o conteúdo original.
4. Arraste a caixa para reposicioná-la; use o canto inferior direito para alterar suas dimensões.
5. Use **Exportar PDF** para baixar o resultado.

## Limitações atuais

- PDFs escaneados normalmente não têm camada de texto. Neles, use caixas de cobertura.
- A exportação cobre o trecho anterior com um fundo branco e desenha o novo texto. Fundos coloridos, imagens e tipografias incorporadas podem exigir ajustes manuais.
- O limite mostrado na interface é de 25 MB; o desempenho também depende da memória disponível no navegador.

## Estrutura

```text
src/App.tsx               Interface, edição e exportação
src/index.css             Entrada do Tailwind CSS
docs/images/              Imagens usadas na documentação
```

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia o ambiente local com recarregamento automático |
| `npm run build` | Verifica os tipos e gera o build de produção |
| `npm run lint` | Executa o ESLint |
| `npm run preview` | Serve o build de produção localmente |
