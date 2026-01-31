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

interface ClassificationParams {
	enableClassification: boolean;
	classificationRequirements?: {
		expectedType?: string;
		requiredFields?: string;
		classificationInstructions?: string;
		failOnTypeMismatch?: boolean;
	};
	detectSignatures: boolean;
}

function getComparisonInstruction(comparisonType: string): string {
	switch (comparisonType) {
		case 'exact':
			return 'Must match exactly (case-sensitive, character-by-character)';
		case 'normalized':
			return 'Normalize both values (remove accents, lowercase, trim spaces) before comparing';
		case 'numeric':
			return 'Extract only numbers from both values (remove dots, dashes, slashes) before comparing';
		case 'date':
			return 'Parse as dates (YYYY-MM-DD format) and compare chronologically';
		case 'semantic':
			return 'Determine if values have the same SEMANTIC MEANING even if written differently (abbreviations, synonyms, variations). Provide reasoning.';
		default:
			return 'Compare as strings';
	}
}

function buildClassificationSystemInstructions(params: ClassificationParams): string {
	const { enableClassification, classificationRequirements, detectSignatures } = params;

	const systemParts: string[] = [];

	if (enableClassification && classificationRequirements?.expectedType) {
		systemParts.push(
			'',
			'DOCUMENT CLASSIFICATION:',
			`- Expected document type: "${classificationRequirements.expectedType}"`,
			`- Required fields for classification: ${classificationRequirements.requiredFields || 'none specified'}`,
		);

		if (classificationRequirements.classificationInstructions) {
			systemParts.push(
				'- Classification rules and indicators:',
				...classificationRequirements.classificationInstructions
					.split('\n')
					.map((line: string) => `  ${line.trim()}`)
					.filter((line: string) => line.trim()),
			);
		}

		systemParts.push(
			'- Determine the actual document type based on content and structure',
			'- Set classification.detectedType to what you detect',
			`- Set classification.expectedType to "${classificationRequirements.expectedType}"`,
			'- Set classification.matches to true/false',
			'- Set classification.confidence (0.0-1.0)',
			'- IMPORTANT: Fill classification.reasoning IN PORTUGUESE with a clear explanation of:',
			'  - Key indicators found that support this classification (headers, formats, specific fields)',
			'  - Why it matches or does not match the expected type',
			'  - Any missing elements or discrepancies',
			'- ALL text outputs must be in Portuguese (Brasil)',
			'',
		);

		if (classificationRequirements.failOnTypeMismatch) {
			systemParts.push("- IMPORTANT: If types don't match, this is a CRITICAL ERROR", '');
		}
	}

	if (detectSignatures) {
		systemParts.push(
			'',
			'SIGNATURE DETECTION:',
			'- Carefully examine the document for signatures (handwritten, digital stamps, or signature images)',
			'- For each signature found:',
			'  - Set detected = true',
			'  - Look for text near the signature and extract:',
			'    - Signer name (usually printed below or above signature)',
			'    - Signer role/title (e.g., "Médico Responsável", "Diretor Técnico")',
			'    - Professional ID (e.g., "CRM 12345-SP", "CREA 67890-RJ", "OAB 11111-MG")',
			'  - Determine location (top-left, top-right, center, bottom-left, bottom-right)',
			'  - Classify type (handwritten, digital, stamp)',
			'- If no signature found, return empty array',
			'',
		);
	}

	return systemParts.join('\n');
}

function buildClassificationSchema(extractionSchema: any): any {
	return {
		type: 'OBJECT',
		properties: {
			classification: {
				type: 'OBJECT',
				nullable: true,
				properties: {
					detectedType: { type: 'STRING', nullable: true },
					expectedType: { type: 'STRING', nullable: true },
					matches: { type: 'BOOLEAN', nullable: true },
					confidence: { type: 'NUMBER', nullable: true },
					reasoning: {
						type: 'STRING',
						nullable: true,
						description: 'Explanation of why the document was classified as this type, including key indicators and characteristics found or missing',
					},
				},
			},
			extraction: extractionSchema,
		},
		required: ['extraction'],
	};
}

function addSignatureDetectionToSchema(schema: any): any {
	return {
		...schema,
		properties: {
			...schema.properties,
			signatures: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						detected: {
							type: 'BOOLEAN',
							description: 'Whether a signature was detected in this location',
						},
						signerName: {
							type: 'STRING',
							nullable: true,
							description: 'Name of person who signed (if visible near signature)',
						},
						signerRole: {
							type: 'STRING',
							nullable: true,
							description: 'Role/title of signer (if visible near signature)',
						},
						signerIdentification: {
							type: 'STRING',
							nullable: true,
							description: 'Professional ID like CRM, CREA, OAB (if visible near signature)',
						},
						signatureLocation: {
							type: 'STRING',
							nullable: true,
							description: 'Location in document: top-left, top-right, center, bottom-left, bottom-right',
						},
						signatureType: {
							type: 'STRING',
							nullable: true,
							description: 'Type: handwritten, digital, stamp',
						},
					},
				},
			},
		},
	};
}

function buildValidateDocumentPrompt(
	extractedData: any,
	referenceData: Array<any>,
	customRules: Array<any>,
): string {
	const prompt: string[] = [];

	prompt.push('You are validating extracted document data against reference data and custom rules.');
	prompt.push('');
	prompt.push('EXTRACTED DATA:');
	prompt.push(JSON.stringify(extractedData, null, 2));
	prompt.push('');

	if (referenceData.length > 0) {
		prompt.push('FIELD COMPARISONS:');
		for (const ref of referenceData) {
			const extractedValue =
				extractedData[ref.fieldName]?.value || extractedData[ref.fieldName] || null;
			prompt.push(`- Field "${ref.fieldName}":`);
			prompt.push(`  - Extracted value: "${extractedValue}"`);
			prompt.push(`  - Reference value: "${ref.expectedValue}"`);
			prompt.push(
				`  - Comparison type: ${getComparisonInstruction(ref.comparisonType)}`,
			);
			prompt.push(
				`  - If mismatch: error message = "${ref.errorMessage || `${ref.fieldName} mismatch`}"`,
			);
		}
		prompt.push('');
	}

	if (customRules.length > 0) {
		prompt.push('CUSTOM VALIDATION RULES:');
		for (const rule of customRules) {
			const fieldValue =
				extractedData[rule.fieldName]?.value || extractedData[rule.fieldName] || null;
			prompt.push(`- Field "${rule.fieldName}":`);
			prompt.push(`  - Value: "${fieldValue}"`);
			prompt.push(`  - Rule: ${rule.ruleDescription}`);
			prompt.push(`  - If fails: "${rule.errorMessage}" (severity: ${rule.severity})`);
		}
		prompt.push('');
	}

	prompt.push('INSTRUCTIONS:');
	prompt.push('- Perform all comparisons according to comparison types specified');
	prompt.push('- Evaluate all custom rules based on their descriptions');
	prompt.push(
		'- For semantic comparisons, determine if values have the same MEANING even if written differently',
	);
	prompt.push(
		'  - Consider abbreviations (Dr. = Doutor, Eng. = Engenheiro, CEO = Chief Executive Officer)',
	);
	prompt.push('  - Consider synonyms and common variations');
	prompt.push('  - Provide reasoning for semantic comparisons IN PORTUGUESE');
	prompt.push('- Set isValid = false if ANY error-severity validation fails');
	prompt.push('- Set isValid = true if all error-severity validations pass (warnings are OK)');
	prompt.push('- Populate comparisons[] with all field comparison results');
	prompt.push('- Populate customValidations[] with all rule evaluation results');
	prompt.push('- Populate errors[] with all error messages from failed validations IN PORTUGUESE');
	prompt.push('- Populate warnings[] with all warning messages IN PORTUGUESE');
	prompt.push('- ALL text outputs must be in Portuguese (Brasil)');

	return prompt.join('\n');
}

function buildValidateDocumentSchema(): any {
	return {
		type: 'OBJECT',
		properties: {
			isValid: {
				type: 'BOOLEAN',
				description:
					'Overall validation result (false if any error-severity validation failed)',
			},
			comparisons: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						field: { type: 'STRING' },
						extractedValue: { type: 'STRING', nullable: true },
						referenceValue: { type: 'STRING', nullable: true },
						matches: { type: 'BOOLEAN' },
						comparisonType: { type: 'STRING' },
						reasoning: {
							type: 'STRING',
							nullable: true,
							description: 'Explanation for semantic comparisons',
						},
						errorMessage: { type: 'STRING', nullable: true },
					},
				},
			},
			customValidations: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						field: { type: 'STRING' },
						ruleDescription: { type: 'STRING' },
						passed: { type: 'BOOLEAN' },
						severity: { type: 'STRING' },
						errorMessage: { type: 'STRING', nullable: true },
					},
				},
			},
			errors: {
				type: 'ARRAY',
				items: { type: 'STRING' },
			},
			warnings: {
				type: 'ARRAY',
				items: { type: 'STRING' },
			},
		},
		required: ['isValid', 'comparisons', 'customValidations', 'errors', 'warnings'],
	};
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
					{
						name: 'Validate Document',
						value: 'validateDocument',
						description: 'Compare extracted data with reference data and validate rules',
						action: 'Validate document data',
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

		// Document Classification
		{
			displayName: 'Enable Document Classification',
			name: 'enableClassification',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					operation: ['multimodal'],
				},
			},
			description: 'Validate document type and extract data only if type matches expectations',
		},
		{
			displayName: 'Classification Requirements',
			name: 'classificationRequirements',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: false,
			},
			default: {},
			displayOptions: {
				show: {
					operation: ['multimodal'],
					enableClassification: [true],
				},
			},
			description: 'Define expected document type and required fields for classification',
			options: [
				{
					name: 'requirements',
					displayName: '',
					values: [
						{
							displayName: 'Expected Document Type',
							name: 'expectedType',
							type: 'string',
							default: '',
							placeholder: 'CNH, RG, ASO, Certificate, etc',
							description: 'Type of document expected (e.g., RG, CNH, ASO)',
						},
						{
							displayName: 'Required Fields for Classification',
							name: 'requiredFields',
							type: 'string',
							default: '',
							placeholder: 'nome, rg, cpf, dataNascimento',
							description: 'Comma-separated list of fields that MUST be present to classify as this type',
						},
						{
							displayName: 'Classification Instructions',
							name: 'classificationInstructions',
							type: 'string',
							typeOptions: {
								rows: 3,
							},
							default: '',
							placeholder: 'Must have "Receita Federal" header\nCPF must be in format ###.###.###-##\nMust show birth date',
							description: 'Optional custom instructions on how to identify this document type. Describe key indicators, patterns, headers, or formatting requirements that distinguish this document.',
						},
						{
							displayName: 'Fail if Type Mismatch',
							name: 'failOnTypeMismatch',
							type: 'boolean',
							default: true,
							description: 'Whether validation should fail if detected type differs from expected type',
						},
					],
				},
			],
		},
		{
			displayName: 'Detect Signatures',
			name: 'detectSignatures',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					operation: ['multimodal'],
				},
			},
			description: 'Detect signatures in the document and extract signer information (name, role, credentials, location)',
		},

			// Validate Document
			{
				displayName: 'Extracted Data',
				name: 'extractedData',
				type: 'json',
				default: '={{ $json.extraction }}',
				required: true,
				displayOptions: {
					show: {
						operation: ['validateDocument'],
					},
				},
				description: 'The extracted data to validate (usually from a previous extraction step)',
			},
			{
				displayName: 'Reference Data',
				name: 'referenceData',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				displayOptions: {
					show: {
						operation: ['validateDocument'],
					},
				},
				description: 'Field-by-field comparisons against expected reference values',
				options: [
					{
						name: 'comparisons',
						displayName: 'Comparison',
						values: [
							{
								displayName: 'Field Name',
								name: 'fieldName',
								type: 'string',
								default: '',
								placeholder: 'cpf, name, birthDate, ...',
								description: 'Name of the field to compare',
							},
							{
								displayName: 'Expected Value',
								name: 'expectedValue',
								type: 'string',
								default: '',
								description: 'The reference value to compare against',
							},
							{
								displayName: 'Comparison Type',
								name: 'comparisonType',
								type: 'options',
								options: [
									{ name: 'Exact Match', value: 'exact' },
									{ name: 'Normalized (no accents, lowercase)', value: 'normalized' },
									{ name: 'Numeric Only (ignore formatting)', value: 'numeric' },
									{ name: 'Date Comparison', value: 'date' },
									{ name: 'Semantic (same meaning)', value: 'semantic' },
								],
								default: 'exact',
								description: 'How to compare the values',
							},
							{
								displayName: 'Error Message',
								name: 'errorMessage',
								type: 'string',
								default: '',
								placeholder: 'CPF does not match expected value',
								description: 'Custom error message if comparison fails',
							},
						],
					},
				],
			},
			{
				displayName: 'Custom Validation Rules',
				name: 'customValidationRules',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				displayOptions: {
					show: {
						operation: ['validateDocument'],
					},
				},
				description: 'Custom validation rules with natural language descriptions',
				options: [
					{
						name: 'rules',
						displayName: 'Rule',
						values: [
							{
								displayName: 'Field Name',
								name: 'fieldName',
								type: 'string',
								default: '',
								placeholder: 'age, date, status, ...',
								description: 'Name of the field to validate',
							},
							{
								displayName: 'Rule Description',
								name: 'ruleDescription',
								type: 'string',
								typeOptions: {
									rows: 2,
								},
								default: '',
								placeholder: 'Must be 18 or older, Date must be in the past, ...',
								description: 'Natural language description of the validation rule',
							},
							{
								displayName: 'Severity',
								name: 'severity',
								type: 'options',
								options: [
									{ name: 'Error', value: 'error' },
									{ name: 'Warning', value: 'warning' },
								],
								default: 'error',
								description: 'Whether rule failure is an error (fails validation) or warning (passes with note)',
							},
							{
								displayName: 'Error Message',
								name: 'errorMessage',
								type: 'string',
								default: '',
								placeholder: 'Patient must be 18 or older',
								description: 'Message to show if rule fails',
							},
						],
					},
				],
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
				// Apply classification wrapper if enabled (multimodal only)
				if (operation === 'multimodal' && responseFormat === 'application/json' && generationConfig.responseSchema) {
					const enableClassificationCheck = this.getNodeParameter('enableClassification', i, false) as boolean;

					if (enableClassificationCheck) {
						const extractionSchema = generationConfig.responseSchema;
						generationConfig.responseSchema = buildClassificationSchema(extractionSchema);
					}

					// Apply signature detection if enabled
					const detectSignaturesCheck = this.getNodeParameter('detectSignatures', i, false) as boolean;
					if (detectSignaturesCheck) {
						generationConfig.responseSchema = addSignatureDetectionToSchema(generationConfig.responseSchema);
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
				// Add classification instructions if enabled
				if (operation === 'multimodal') {
					const enableClassificationCheck = this.getNodeParameter('enableClassification', i, false) as boolean;
					const detectSignaturesCheck = this.getNodeParameter('detectSignatures', i, false) as boolean;

					if (enableClassificationCheck || detectSignaturesCheck) {
						const classificationRequirementsParam = this.getNodeParameter('classificationRequirements', i, {}) as any;
						const classificationRequirements = classificationRequirementsParam?.requirements;

						const classificationInstructions = buildClassificationSystemInstructions({
							enableClassification: enableClassificationCheck,
							classificationRequirements,
							detectSignatures: detectSignaturesCheck,
						});

						if (classificationInstructions) {
							systemParts.push(classificationInstructions);
						}
					}
				}

				const generativeModel = vertexAI.getGenerativeModel({
					model,
					generationConfig,
					systemInstruction: systemParts.length
						? { role: 'system', parts: [{ text: systemParts.join('\n') }] }
						: undefined,
				});

				// Handle validateDocument operation
				if (operation === 'validateDocument') {
					const extractedDataParam = this.getNodeParameter('extractedData', i) as any;
					const extractedData = typeof extractedDataParam === 'string'
						? JSON.parse(extractedDataParam)
						: extractedDataParam;

					const referenceDataParam = this.getNodeParameter('referenceData', i, {}) as {
						comparisons?: Array<any>;
					};
					const referenceData = referenceDataParam.comparisons || [];

					const customValidationRulesParam = this.getNodeParameter('customValidationRules', i, {}) as {
						rules?: Array<any>;
					};
					const customValidationRules = customValidationRulesParam.rules || [];

					// Build validation prompt
					const validationPrompt = buildValidateDocumentPrompt(
						extractedData,
						referenceData,
						customValidationRules,
					);

					// Build validation schema
					const validationSchema = buildValidateDocumentSchema();

					// Create a validation-specific model with low temperature
					const validationModel = vertexAI.getGenerativeModel({
						model,
						generationConfig: {
							maxOutputTokens: options.maxOutputTokens || 2048,
							temperature: 0.1,
							topP: 0.95,
							topK: 40,
							responseMimeType: 'application/json',
							responseSchema: validationSchema,
						},
					});

					// Generate validation result
					const timeoutMs = options.timeout || 60000;
					const validatePromise = validationModel.generateContent({
						contents: [{ role: 'user', parts: [{ text: validationPrompt }] }],
					});

					const timeoutPromise = new Promise<never>((_, reject) => {
						setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
					});

					const validationResult = await Promise.race([validatePromise, timeoutPromise]);
					const validationResponse = validationResult.response;

					const validationText = concatTextFromResponse(validationResponse);
					const validationJson = tryParseJson(validationText);

					returnData.push({
						json: {
							validation: validationJson,
							text: validationText,
							model,
							operation,
							usage: validationResponse?.usageMetadata,
						},
					});

					continue;
				}

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

				// When classification is enabled, spread parsed JSON fields directly
				const enableClassificationCheck = operation === 'multimodal'
					? this.getNodeParameter('enableClassification', i, false) as boolean
					: false;

				const outputJson: Record<string, any> = {
					...(enableClassificationCheck && parsedJson !== null ? parsedJson : {}),
					...(!enableClassificationCheck && parsedJson !== null ? { json: parsedJson } : {}),
					text: generatedText,
					model,
					operation,
					usage: response?.usageMetadata,
					safetyRatings: response?.candidates?.[0]?.safetyRatings,
					finishReason: response?.candidates?.[0]?.finishReason,
				};

				returnData.push({
					json: outputJson,
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
