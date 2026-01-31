import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { VertexAI as VertexAIClient, Part, Content } from '@google-cloud/vertexai';

interface ServiceAccountKey {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	client_id: string;
	auth_uri: string;
	token_uri: string;
}

interface ChatMessage {
	role: string;
	content: string;
}

function concatTextFromResponse(resp: any): string {
	const parts = resp?.candidates?.[0]?.content?.parts || [];
	return parts.map((p: any) => p?.text ?? '').join('').trim();
}

function splitCsv(value: string): string[] {
	return value
		.split(',')
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

function extractJsonString(text: string): string {
	const trimmed = (text ?? '').trim();

	// Remove ```json ... ```
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();

	// Try object
	const firstObj = trimmed.indexOf('{');
	const lastObj = trimmed.lastIndexOf('}');
	if (firstObj >= 0 && lastObj > firstObj) {
		return trimmed.slice(firstObj, lastObj + 1);
	}

	// Try array
	const firstArr = trimmed.indexOf('[');
	const lastArr = trimmed.lastIndexOf(']');
	if (firstArr >= 0 && lastArr > firstArr) {
		return trimmed.slice(firstArr, lastArr + 1);
	}

	return trimmed;
}

function tryParseJson(text: string): any | null {
	try {
		return JSON.parse(extractJsonString(text));
	} catch {
		return null;
	}
}

function coerceJsonSchema(value: unknown): any | null {
	if (value && typeof value === 'object') return value;
	if (typeof value === 'string' && value.trim()) return JSON.parse(value);
	return null;
}

export class VertexAI implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Vertex AI',
		name: 'vertexAI',
		icon: 'file:vertex-ai.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Google Vertex AI Gemini API',
		defaults: {
			name: 'Vertex AI',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'vertexAiApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Generate Text',
						value: 'generateText',
						description: 'Generate text from a prompt',
						action: 'Generate text from a prompt',
					},
					{
						name: 'Chat',
						value: 'chat',
						description: 'Have a multi-turn conversation',
						action: 'Have a multi turn conversation',
					},
					{
						name: 'Multimodal',
						value: 'multimodal',
						description: 'Process text and files together',
						action: 'Process text and files together',
					},
				],
				default: 'generateText',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				options: [
					{ name: 'Gemini 3 Pro (Preview)', value: 'gemini-3-pro-preview' },
					{ name: 'Gemini 3 Flash (Preview)', value: 'gemini-3-flash-preview' },
					{ name: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
					{ name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
					{ name: 'Gemini 2.5 Flash Lite', value: 'gemini-2.5-flash-lite' },
					{ name: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash-001' },
					{ name: 'Gemini 2.0 Flash Lite', value: 'gemini-2.0-flash-lite-001' },
					{ name: 'Gemini 1.5 Pro', value: 'gemini-1.5-pro-002' },
					{ name: 'Gemini 1.5 Flash', value: 'gemini-1.5-flash-002' },
				],
				default: 'gemini-2.5-flash',
				description: 'The Gemini model to use',
			},

			// Generate Text
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['generateText'],
					},
				},
				description: 'The text prompt to send to the model',
			},

			// Chat
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				displayOptions: {
					show: {
						operation: ['chat'],
					},
				},
				options: [
					{
						name: 'messageValues',
						displayName: 'Message',
						values: [
							{
								displayName: 'Role',
								name: 'role',
								type: 'options',
								options: [
									{ name: 'User', value: 'user' },
									{ name: 'Model', value: 'model' },
								],
								default: 'user',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: {
									rows: 2,
								},
								default: '',
							},
						],
					},
				],
				description: 'The conversation messages',
			},

			// Evidence
			{
				displayName: 'Include Evidence',
				name: 'includeEvidence',
				type: 'boolean',
				default: false,
				description: 'Return each field as { value, evidence } with literal proof from the document',
				displayOptions: {
					show: {
						responseFormat: ['application/json'],
						schemaMode: ['simple'],
					},
				},
			},

			// Confidence
			{
				displayName: 'Include Confidence',
				name: 'includeConfidence',
				type: 'boolean',
				default: false,
				description: 'Add confidence (0.0 to 1.0) for each extracted field',
				displayOptions: {
					show: {
						responseFormat: ['application/json'],
						schemaMode: ['simple'],
						includeEvidence: [true],
					},
				},
			},

			// Full Text
			{
				displayName: 'Include Full Text',
				name: 'includeFullText',
				type: 'boolean',
				default: false,
				description: 'Include the full extracted text as metadata (not part of the structured result)',
			},

			// Multimodal
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['multimodal'],
					},
				},
				description: 'The text to send with the file',
			},
			{
				displayName: 'File Source',
				name: 'imageSource',
				type: 'options',
				options: [
					{ name: 'Binary Data', value: 'binary' },
					{ name: 'URL', value: 'url' },
					{ name: 'Base64', value: 'base64' },
				],
				default: 'binary',
				displayOptions: {
					show: {
						operation: ['multimodal'],
					},
				},
			},
			{
				displayName: 'URL MIME Type',
				name: 'urlMimeType',
				type: 'options',
				options: [
					{ name: 'image/jpeg', value: 'image/jpeg' },
					{ name: 'image/png', value: 'image/png' },
					{ name: 'application/pdf', value: 'application/pdf' },
					{ name: 'text/plain', value: 'text/plain' },
				],
				default: 'application/pdf',
				displayOptions: {
					show: {
						operation: ['multimodal'],
						imageSource: ['url'],
					},
				},
				description: 'MIME type for the file referenced by the URL',
			},
			{
				displayName: 'Base64 MIME Type',
				name: 'base64MimeType',
				type: 'options',
				options: [
					{ name: 'image/jpeg', value: 'image/jpeg' },
					{ name: 'image/png', value: 'image/png' },
					{ name: 'application/pdf', value: 'application/pdf' },
					{ name: 'text/plain', value: 'text/plain' },
				],
				default: 'application/pdf',
				displayOptions: {
					show: {
						operation: ['multimodal'],
						imageSource: ['base64'],
					},
				},
				description: 'MIME type for the provided base64 content',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						operation: ['multimodal'],
						imageSource: ['binary'],
					},
				},
				description: 'Name of the binary property containing the file',
			},
			{
				displayName: 'File URL',
				name: 'imageUrl',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['multimodal'],
						imageSource: ['url'],
					},
				},
				description: 'Direct URL to the file',
			},
			{
				displayName: 'Base64 File',
				name: 'base64Image',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['multimodal'],
						imageSource: ['base64'],
					},
				},
				description: 'Base64 encoded file data (without data:* prefix)',
			},

			// Options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Max Output Tokens',
						name: 'maxOutputTokens',
						type: 'number',
						default: 2048,
						description: 'Maximum number of tokens to generate',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: {
							minValue: 0,
							maxValue: 2,
							numberStepSize: 0.1,
						},
						default: 1,
						description: 'Controls randomness (0-2)',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						typeOptions: {
							minValue: 0,
							maxValue: 1,
							numberStepSize: 0.1,
						},
						default: 0.95,
						description: 'Nucleus sampling threshold',
					},
					{
						displayName: 'Top K',
						name: 'topK',
						type: 'number',
						default: 40,
						description: 'Top-k sampling threshold',
					},
					{
						displayName: 'System Instruction',
						name: 'systemInstruction',
						type: 'string',
						typeOptions: {
							rows: 3,
						},
						default: '',
						description: 'System instruction to guide model behavior',
					},
					{
						displayName: 'Thinking Level (Gemini 3 only)',
						name: 'thinkingLevel',
						type: 'options',
						options: [
							{ name: 'None', value: 'none' },
							{ name: 'Low', value: 'low' },
							{ name: 'High', value: 'high' },
						],
						default: 'none',
						description:
							'Controls internal reasoning for Gemini 3 models. Use "low" or "high" to enable thinking.',
					},
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						default: 60000,
						description:
							'API request timeout in milliseconds. Default is 60000ms (60 seconds). Increase if you expect long responses.',
					},
				],
			},

			// Structured Output
			{
				displayName: 'Response Format',
				name: 'responseFormat',
				type: 'options',
				options: [
					{ name: 'Plain Text', value: 'text/plain' },
					{ name: 'JSON', value: 'application/json' },
					{ name: 'Enum', value: 'text/x.enum' },
				],
				default: 'text/plain',
				description:
					'Select the response format. JSON or Enum requires schema configuration.',
			},
			{
				displayName: 'Schema Mode',
				name: 'schemaMode',
				type: 'options',
				options: [
					{ name: 'Simple (UI)', value: 'simple' },
					{ name: 'Advanced (JSON Schema)', value: 'advanced' },
				],
				default: 'simple',
				displayOptions: {
					show: {
						responseFormat: ['application/json', 'text/x.enum'],
					},
				},
				description:
					'Select how to provide a schema. Simple uses UI fields; Advanced uses raw JSON schema.',
			},
			{
				displayName: 'Enum Values',
				name: 'enumValues',
				type: 'string',
				default: '',
				placeholder: 'positive, negative, neutral',
				displayOptions: {
					show: {
						responseFormat: ['text/x.enum'],
						schemaMode: ['simple'],
					},
				},
				description: 'Comma-separated enum values, e.g. positive, negative, neutral',
			},
			{
				displayName: 'Schema Properties',
				name: 'schemaProperties',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				displayOptions: {
					show: {
						responseFormat: ['application/json'],
						schemaMode: ['simple'],
					},
				},
				description:
					'Define JSON response properties. Click "Add Property" to add fields.',
				options: [
					{
						name: 'properties',
						displayName: 'Property',
						values: [
							{
								displayName: 'Property Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'name, email, age, ...',
								description: 'Property name (English recommended)',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'String', value: 'string' },
									{ name: 'Number', value: 'number' },
									{ name: 'Integer', value: 'integer' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Array of Strings', value: 'array_string' },
									{ name: 'Array of Numbers', value: 'array_number' },
									{ name: 'Object (Nested; prefer Advanced mode)', value: 'object' },
								],
								default: 'string',
								description: 'The type of this property',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								placeholder: 'Describe this field...',
								description: 'Field description to help the model',
							},
							{
								displayName: 'Required',
								name: 'required',
								type: 'boolean',
								default: true,
								description: 'Whether this property must be included',
							},
							{
								displayName: 'Nullable',
								name: 'nullable',
								type: 'boolean',
								default: false,
								description: 'Whether null is allowed when a value is not found',
							},
							{
								displayName: 'Allowed Values',
								name: 'enumValues',
								type: 'string',
								default: '',
								placeholder: 'option1, option2, option3',
								description:
									'Allowed values (string type only). Comma-separated. Empty means any value allowed.',
							},
						],
					},
				],
			},
			{
				displayName: 'Response Schema (JSON)',
				name: 'responseSchema',
				type: 'json',
				default: '',
				displayOptions: {
					show: {
						responseFormat: ['application/json', 'text/x.enum'],
						schemaMode: ['advanced'],
					},
				},
				description:
					'Define the output schema as JSON. Example: {"type":"OBJECT","properties":{"name":{"type":"STRING"}},"required":["name"]}',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('vertexAiApi');
		const projectId = credentials.projectId as string;
		const region = credentials.region as string;
		const serviceAccountKeyStr = credentials.serviceAccountKey as string;

		let serviceAccountKey: ServiceAccountKey;
		try {
			serviceAccountKey = JSON.parse(serviceAccountKeyStr);
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				'Invalid Service Account Key JSON. Please paste the entire JSON content from your service account key file.',
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const model = this.getNodeParameter('model', i) as string;

				// Structured output parameters
				const responseFormat = this.getNodeParameter('responseFormat', i, 'text/plain') as string;
				const schemaMode = this.getNodeParameter('schemaMode', i, 'simple') as string;
				const enumValues = this.getNodeParameter('enumValues', i, '') as string;

				interface SchemaProperty {
					name: string;
					type: string;
					description?: string;
					required?: boolean;
					nullable?: boolean;
					enumValues?: string;
				}

				const schemaProperties = this.getNodeParameter('schemaProperties', i, {}) as {
					properties?: SchemaProperty[];
				};
				const responseSchema = this.getNodeParameter('responseSchema', i, '') as string;

				const options = this.getNodeParameter('options', i, {}) as {
					maxOutputTokens?: number;
					temperature?: number;
					topP?: number;
					topK?: number;
					systemInstruction?: string;
					thinkingLevel?: string;
					timeout?: number;
				};

				// Preview models require global location
				const isPreviewModel = model.includes('preview');
				const isGemini3 = model.includes('gemini-3');
				const location = isPreviewModel ? 'global' : region;

				const vertexAI = new VertexAIClient({
					project: projectId,
					location,
					apiEndpoint: isPreviewModel ? 'aiplatform.googleapis.com' : undefined,
					googleAuthOptions: {
						credentials: serviceAccountKey,
					},
				});

				// Generation config
				const generationConfig: Record<string, unknown> = {
					maxOutputTokens: options.maxOutputTokens || 2048,
					temperature: options.temperature ?? 1,
					topP: options.topP ?? 0.95,
					topK: options.topK ?? 40,
				};

				// Thinking config for Gemini 3
				if (isGemini3 && options.thinkingLevel && options.thinkingLevel !== 'none') {
					generationConfig.thinkingConfig = {
						thinkingLevel: options.thinkingLevel.toUpperCase(),
					};
				}

				// ===== Structured Output + Evidence Mode =====
				if (responseFormat && responseFormat !== 'text/plain') {
					generationConfig.responseMimeType = responseFormat;

					const requiresSchema =
						responseFormat === 'application/json' || responseFormat === 'text/x.enum';

					const includeEvidence = this.getNodeParameter('includeEvidence', i, false) as boolean;
					const includeConfidence = this.getNodeParameter('includeConfidence', i, false) as boolean;
					const includeFullText = this.getNodeParameter('includeFullText', i, false) as boolean;

					if (schemaMode === 'simple') {
						// Enum
						if (responseFormat === 'text/x.enum') {
							const enumArray = splitCsv(enumValues);
							if (!enumArray.length) {
								throw new NodeOperationError(
									this.getNode(),
									'Enum Values is required when Response Format is Enum.',
									{ itemIndex: i },
								);
							}

							generationConfig.responseSchema = {
								type: 'STRING',
								enum: enumArray,
							};
						}

						// JSON
						if (responseFormat === 'application/json') {
							const schemaProps = schemaProperties?.properties || [];
							if (!schemaProps.length) {
								throw new NodeOperationError(
									this.getNode(),
									'Schema Properties is required when Response Format is JSON.',
									{ itemIndex: i },
								);
							}

							const properties: Record<string, any> = {};
							const required: string[] = [];

							for (const prop of schemaProps) {
								if (!prop.name) continue;

								let baseSchema: any;

								if (prop.type === 'array_string') {
									baseSchema = { type: 'ARRAY', items: { type: 'STRING' } };
								} else if (prop.type === 'array_number') {
									baseSchema = { type: 'ARRAY', items: { type: 'NUMBER' } };
								} else {
									baseSchema = { type: prop.type.toUpperCase() };
								}

								if (prop.description) baseSchema.description = prop.description;
								if (prop.nullable) baseSchema.nullable = true;

								if (prop.type === 'string' && prop.enumValues) {
									const enumArray = splitCsv(prop.enumValues);
									if (enumArray.length) baseSchema.enum = enumArray;
								}

								if (includeEvidence) {
									const wrappedProps: Record<string, any> = {
										value: { ...baseSchema, nullable: true },
										evidence: {
											type: 'STRING',
											nullable: true,
											description:
												'Literal excerpt copied from the document/OCR including surrounding context proving the value.',
										},
									};

									const wrappedRequired = ['value', 'evidence'];

									if (includeConfidence) {
										wrappedProps.confidence = {
											type: 'NUMBER',
											nullable: true,
											description: 'Confidence from 0.0 to 1.0 about extraction correctness',
										};
										wrappedRequired.push('confidence');
									}

									properties[prop.name] = {
										type: 'OBJECT',
										properties: wrappedProps,
										required: wrappedRequired,
									};
								} else {
									properties[prop.name] = baseSchema;
								}

								if (prop.required) required.push(prop.name);
							}

							// Optional metadata with full extracted text
							if (includeFullText) {
								properties._meta = {
									type: 'OBJECT',
									properties: {
										fullText: {
											type: 'STRING',
											nullable: true,
											description: 'Full extracted text from the document (may be truncated).',
										},
										fullTextTruncated: {
											type: 'BOOLEAN',
											nullable: true,
											description: 'True if fullText was truncated due to size limits.',
										},
									},
									required: ['fullText'],
								};
							}

							generationConfig.responseSchema = {
								type: 'OBJECT',
								properties,
								...(required.length ? { required } : {}),
							};
						}
					} else {
						// Advanced JSON schema
						const schema = coerceJsonSchema(responseSchema);

						if (requiresSchema && !schema) {
							throw new NodeOperationError(
								this.getNode(),
								'Response Schema (JSON) is required in Advanced mode when Response Format is JSON or Enum.',
								{ itemIndex: i },
							);
						}

						if (schema) generationConfig.responseSchema = schema;
					}
				}

				const includeEvidence = this.getNodeParameter('includeEvidence', i, false) as boolean;
				const includeConfidence = this.getNodeParameter('includeConfidence', i, false) as boolean;
				const includeFullText = this.getNodeParameter('includeFullText', i, false) as boolean;

				const systemParts: string[] = [];
				if (options.systemInstruction) systemParts.push(options.systemInstruction);

				if (includeEvidence) {
					systemParts.push(
						'IMPORTANT (Evidence Mode):',
						'- For each field, always return both "value" and "evidence".',
						'- "evidence" must be a LITERAL excerpt copied from the document/OCR and should include surrounding context (e.g., labels like "CPF:", nearby words).',
						'- Prefer evidence length 20-120 characters when possible; evidence should contain the value as a substring when applicable.',
						'- If you cannot find clear contextual evidence, return null for BOTH value and evidence.',
					);

					if (includeConfidence) {
						systemParts.push(
							'- Also return "confidence" (0.0 to 1.0) for each field.',
							'- 0.9-1.0: clear label + value. 0.6-0.8: present but noisy. 0.1-0.5: uncertain. If very uncertain, return nulls.',
						);
					}
				}

				if (includeFullText) {
					systemParts.push(
						'If the output schema contains "_meta.fullText":',
						'- Fill it with the full extracted text from the document.',
						'- Do not add analysis or summaries.',
						'- If the text is very long, truncate to the most complete text possible and set "_meta.fullTextTruncated" = true.',
					);

					systemParts.push('- Hard limit: fullText must be <= 3000 characters.');
				}

				const generativeModel = vertexAI.getGenerativeModel({
					model,
					generationConfig,
					systemInstruction: systemParts.length
						? { role: 'system', parts: [{ text: systemParts.join('\n') }] }
						: undefined,
				});

				let contents: Content[];

				if (operation === 'generateText') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					contents = [{ role: 'user', parts: [{ text: prompt }] }];
				} else if (operation === 'chat') {
					const messagesData = this.getNodeParameter('messages', i, {}) as {
						messageValues?: ChatMessage[];
					};
					const messages = messagesData.messageValues || [];
					contents = messages.map((msg) => ({
						role: msg.role,
						parts: [{ text: msg.content }],
					}));
				} else {
					const text = this.getNodeParameter('text', i, '') as string;
					const imageSource = this.getNodeParameter('imageSource', i) as string;

					let filePart: Part;

					if (imageSource === 'binary') {
						const binaryProperty = this.getNodeParameter('binaryProperty', i) as string;
						const binaryData = this.helpers.assertBinaryData(i, binaryProperty);
						const buffer = await this.helpers.getBinaryDataBuffer(i, binaryProperty);

						filePart = {
							inlineData: {
								mimeType: binaryData.mimeType || 'application/octet-stream',
								data: buffer.toString('base64'),
							},
						};
					} else if (imageSource === 'url') {
						const fileUrl = this.getNodeParameter('imageUrl', i) as string;
						const urlMimeType = this.getNodeParameter('urlMimeType', i, 'application/pdf') as string;

						filePart = {
							fileData: {
								fileUri: fileUrl,
								mimeType: urlMimeType,
							},
						};
					} else {
						const base64 = this.getNodeParameter('base64Image', i) as string;
						const base64MimeType = this.getNodeParameter('base64MimeType', i, 'application/pdf') as string;

						filePart = {
							inlineData: {
								mimeType: base64MimeType,
								data: base64.replace(/^data:.*;base64,/, ''),
							},
						};
					}

					contents = [
						{
							role: 'user',
							parts: [{ text: text || 'Describe this file' }, filePart],
						},
					];
				}

				// Generate with timeout
				const timeoutMs = options.timeout || 60000;
				const generatePromise = generativeModel.generateContent({ contents });

				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
				});

				const result = await Promise.race([generatePromise, timeoutPromise]);
				const response = result.response;

				const parts = response?.candidates?.[0]?.content?.parts || [];
				const generatedText = parts.map((p: any) => p?.text ?? '').join('').trim();

				let parsedJson: any = null;
				if (responseFormat === 'application/json' && generatedText) {
					parsedJson = tryParseJson(generatedText);
				}

				returnData.push({
					json: {
						text: generatedText,
						...(parsedJson !== null && { json: parsedJson }),
						model,
						operation,
						usage: response?.usageMetadata,
						safetyRatings: response?.candidates?.[0]?.safetyRatings,
						finishReason: response?.candidates?.[0]?.finishReason,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Vertex AI Error: ${(error as Error).message}`, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}
