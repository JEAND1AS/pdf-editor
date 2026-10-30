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

> O editor atual continua funcionando localmente no navegador. A API opcional adicionada ao projeto permite contas e armazenamento protegido por usuário.

## API segura (contas e documentos)

O projeto agora é dividido em `frontend/` (React/Vite) e `backend/` (Fastify/SQLite). O backend disponibiliza cadastro, login, sessão e upload de PDFs. Cada rota de documento exige uma sessão válida e consulta o proprietário no banco antes de listar, baixar ou excluir o arquivo.

```bash
cp backend/.env.example backend/.env
# Preencha COOKIE_SECRET com: openssl rand -base64 48
npm run api
```

Em outro terminal, use `npm run dev` para a interface. O Vite encaminha `/api` e `/health` ao backend local por padrão. Para chamadas autenticadas, primeiro obtenha `GET /api/auth/csrf` e envie o token retornado no cabeçalho `X-CSRF-Token` em toda requisição que altera estado.

Principais rotas: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET/POST /api/documents`, `GET /api/documents/:id`, `PUT /api/documents/:id/edits`, `GET /api/documents/:id/download` e `DELETE /api/documents/:id`.

O frontend já usa essas rotas: após entrar, novos PDFs são enviados para a conta, documentos salvos podem ser reabertos e o botão **Salvar** persiste as caixas de edição. A exportação também salva as alterações antes de gerar o download.

O backend usa Argon2id para senhas, cookies `HttpOnly`/`SameSite=Strict` (e `Secure` em produção), tokens anti-CSRF, limites de tentativa e upload, CORS restrito à origem configurada, cabeçalhos HTTP de proteção e identificadores aleatórios. Dados e PDFs são guardados em `backend/data/`, que não é versionado. Em produção, defina `NODE_ENV=production`, uma origem HTTPS em `CLIENT_ORIGIN`, um segredo exclusivo fora do repositório e execute atrás de HTTPS; só habilite `TRUST_PROXY=true` se houver um proxy reverso confiável.

## Tecnologias

| Tecnologia         | Uso                                       |
| ------------------ | ----------------------------------------- |
| React + TypeScript | Interface e lógica da aplicação           |
| Vite               | Ambiente de desenvolvimento e build       |
| Tailwind CSS 4     | Estilos utilitários e responsividade      |
| PDF.js             | Renderização e leitura da camada de texto |
| pdf-lib            | Geração do PDF exportado                  |

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
frontend/src/App.tsx      Interface, edição e exportação
frontend/src/index.css    Entrada do Tailwind CSS
backend/src/              API, autenticação e armazenamento
docs/images/              Imagens usadas na documentação
```

## Scripts

| Comando           | Descrição                                             |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Inicia o ambiente local com recarregamento automático |
| `npm run api`     | Inicia a API do backend                               |
| `npm run build`   | Verifica os tipos e gera o build de produção          |
| `npm run lint`    | Executa o ESLint                                      |
| `npm run preview` | Serve o build de produção localmente                  |
