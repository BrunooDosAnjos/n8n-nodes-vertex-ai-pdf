## Fork notice

This repository is a fork of **pokabook/n8n-nodes-vertex-ai**.

Additional features in this fork:
- Multimodal PDF support (binary, URL and base64)
- Generic file handling using official Gemini multimodal capabilities

NPM package:
- @brunodosanjos/n8n-nodes-vertex-ai-pdf

---

# n8n-nodes-vertex-ai-pdf

English | Português

---

====================
ENGLISH
====================

A community node for n8n that integrates with Google Vertex AI (Gemini models).

This fork extends the original node with full PDF support in multimodal mode, allowing document analysis, summarization and structured data extraction directly from PDF files.

Features
- Text Generation
- Chat (multi-turn)
- Multimodal (images and PDF files)
- Binary, URL and Base64 inputs
- Structured output (JSON / Enum)
- Support for Gemini 3, 2.5, 2.0 and 1.5 models

Installation (n8n)
1. Settings -> Community Nodes
2. Install a community node
3. Enter: @brunodosanjos/n8n-nodes-vertex-ai-pdf
4. Install and restart n8n

Manual Installation
npm install @brunodosanjos/n8n-nodes-vertex-ai-pdf

Setup Summary
- Create Google Cloud project
- Enable Vertex AI API
- Create Service Account with role: Vertex AI User
- Generate JSON key
- Configure credentials in n8n

Multimodal PDF Example
- Use HTTP Request or Read Binary File to load a PDF
- Set operation to Multimodal
- Source: Binary
- Prompt example:
  "Summarize this PDF and extract the main topics"

---

====================
PORTUGUÊS
====================

Este é um node de comunidade para o n8n que integra com o Google Vertex AI (modelos Gemini).

Este fork adiciona suporte completo a arquivos PDF no modo multimodal, permitindo análise de documentos, sumarização e extração estruturada de dados diretamente de PDFs.

Funcionalidades
- Geração de texto
- Chat com contexto
- Multimodal (imagens e PDFs)
- Entrada via Binary, URL ou Base64
- Saída estruturada (JSON / Enum)
- Suporte aos modelos Gemini 3, 2.5, 2.0 e 1.5

Instalação no n8n
1. Settings -> Community Nodes
2. Install a community node
3. Informe: @brunodosanjos/n8n-nodes-vertex-ai-pdf
4. Instale e reinicie o n8n

Instalação manual
npm install @brunodosanjos/n8n-nodes-vertex-ai-pdf

Resumo de configuração
- Criar projeto no Google Cloud
- Ativar a API Vertex AI
- Criar Service Account com papel Vertex AI User
- Gerar chave JSON
- Configurar credenciais no n8n

Exemplo multimodal com PDF
- Carregue um PDF usando HTTP Request ou Read Binary File
- Operação: Multimodal
- Source: Binary
- Prompt exemplo:
  "Resuma este PDF e extraia os principais tópicos"

---

License: MIT
