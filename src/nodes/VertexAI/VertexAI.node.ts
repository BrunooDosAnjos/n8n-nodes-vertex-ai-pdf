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

async function buildFileParts(
	executeFunctions: IExecuteFunctions,
	documents: Array<any>,
	itemIndex: number,
): Promise<Array<Part>> {
	const fileParts: Part[] = [];

	for (const doc of documents) {
		const { fileSource, binaryProperty, fileUrl, urlMimeType, base64File, base64MimeType } = doc;

		let filePart: Part;

		if (fileSource === 'binary') {
			const binaryData = executeFunctions.helpers.assertBinaryData(itemIndex, binaryProperty);
			const buffer = await executeFunctions.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
			filePart = {
				inlineData: {
					mimeType: binaryData.mimeType || 'application/octet-stream',
					data: buffer.toString('base64'),
				},
			};
		} else if (fileSource === 'url') {
			filePart = {
				fileData: {
					fileUri: fileUrl,
					mimeType: urlMimeType,
				},
			};
		} else {
			filePart = {
				inlineData: {
					mimeType: base64MimeType,
					data: base64File.replace(/^data:.*;base64,/, ''),
				},
			};
		}

		fileParts.push(filePart);
	}

	return fileParts;
}

function buildMultiDocumentComparisonPrompt(
	documents: Array<{ documentLabel: string; documentType?: string }>,
	fieldComparisons: Array<any>,
	customRules: Array<any>,
	enableAutoDetection: boolean,
): string {
	const prompt: string[] = [];

	prompt.push('You are analyzing and comparing multiple documents to validate consistency and detect discrepancies.');
	prompt.push('');
	prompt.push('DOCUMENTS TO ANALYZE:');
	documents.forEach((doc, idx) => {
		prompt.push(`${idx + 1}. Document "${doc.documentLabel}"${doc.documentType ? ` (Expected Type: ${doc.documentType})` : ''}`);
	});
	prompt.push('');

	if (fieldComparisons.length > 0) {
		prompt.push('FIELD-TO-FIELD COMPARISON RULES:');
		for (const comp of fieldComparisons) {
			prompt.push(`- Compare "${comp.sourceDocument}.${comp.sourceField}" with "${comp.targetDocument}.${comp.targetField}":`);
			prompt.push(`  - Comparison type: ${getComparisonInstruction(comp.comparisonType)}`);
			prompt.push(`  - If mismatch: "${comp.errorMessage}"`);
		}
		prompt.push('');
	}

	if (customRules.length > 0) {
		prompt.push('CUSTOM CROSS-DOCUMENT VALIDATION RULES:');
		for (const rule of customRules) {
			prompt.push(`- Rule: ${rule.ruleName}`);
			prompt.push(`  - Description: ${rule.ruleDescription}`);
			prompt.push(`  - Severity: ${rule.severity}`);
			prompt.push(`  - If fails: "${rule.errorMessage}"`);
		}
		prompt.push('');
	}

	if (enableAutoDetection) {
		prompt.push('AUTO-DETECTION OF INCONSISTENCIES:');
		prompt.push('- Automatically identify ANY discrepancies across documents');
		prompt.push('- Look for: conflicting information, date inconsistencies, name variations, missing fields, suspicious patterns');
		prompt.push('- Report each issue with document references and severity');
		prompt.push('');
	}

	prompt.push('INSTRUCTIONS:');
	prompt.push('- Extract fields from each document according to schema');
	prompt.push('- Perform all field comparisons and custom rules');
	prompt.push('- If auto-detection enabled, find additional inconsistencies');
	prompt.push('- Set overallValid = false if ANY error-severity issue found');
	prompt.push('- ALL text outputs must be in Portuguese (Brasil)');

	return prompt.join('\n');
}

function buildMultiDocumentComparisonSchema(
	documents: Array<{ documentLabel: string }>,
	extractionProperties: Array<any>,
	enableAutoDetection: boolean,
): any {
	const documentSchemas: Record<string, any> = {};

	for (const doc of documents) {
		const properties: Record<string, any> = {};

		for (const prop of extractionProperties) {
			let schemaType: any;

			if (prop.type === 'date') {
				schemaType = {
					type: 'STRING',
					description: `${prop.description || ''} (Format: YYYY-MM-DD)`,
				};
			} else {
				schemaType = {
					type: prop.type.toUpperCase(),
					description: prop.description || '',
				};
			}

			if (prop.nullable) schemaType.nullable = true;
			properties[prop.name] = schemaType;
		}

		documentSchemas[doc.documentLabel] = {
			type: 'OBJECT',
			properties,
			nullable: true,
		};
	}

	const schema: any = {
		type: 'OBJECT',
		properties: {
			overallValid: {
				type: 'BOOLEAN',
				description: 'Whether all error-level validations passed',
			},
			documents: {
				type: 'OBJECT',
				properties: documentSchemas,
			},
			fieldComparisons: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						sourceDocument: { type: 'STRING' },
						sourceField: { type: 'STRING' },
						sourceValue: { type: 'STRING', nullable: true },
						targetDocument: { type: 'STRING' },
						targetField: { type: 'STRING' },
						targetValue: { type: 'STRING', nullable: true },
						matches: { type: 'BOOLEAN' },
						comparisonType: { type: 'STRING' },
						reasoning: { type: 'STRING', nullable: true },
						errorMessage: { type: 'STRING', nullable: true },
					},
				},
			},
			customRuleResults: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						ruleName: { type: 'STRING' },
						ruleDescription: { type: 'STRING' },
						passed: { type: 'BOOLEAN' },
						severity: { type: 'STRING' },
						reasoning: { type: 'STRING', nullable: true },
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
		required: ['overallValid', 'documents', 'fieldComparisons', 'customRuleResults', 'errors', 'warnings'],
	};

	if (enableAutoDetection) {
		schema.properties.autoDetectedIssues = {
			type: 'ARRAY',
			items: {
				type: 'OBJECT',
				properties: {
					issueType: { type: 'STRING' },
					description: { type: 'STRING' },
					affectedDocuments: {
						type: 'ARRAY',
						items: { type: 'STRING' },
					},
					affectedFields: {
						type: 'ARRAY',
						items: { type: 'STRING' },
					},
					severity: { type: 'STRING' },
					reasoning: { type: 'STRING' },
				},
			},
		};
	}

	return schema;
}

function buildMultimodalMultiDocumentSchema(
	documents: Array<{ documentLabel?: string }>,
	extractionProperties: Array<any>,
	enableClassification: boolean,
	classificationRequirements: any,
	detectSignatures: boolean,
	includeEvidence: boolean,
	includeConfidence: boolean,
): any {
	const documentSchemas: Record<string, any> = {};

	documents.forEach((doc, idx) => {
		const label = doc.documentLabel || `Document ${idx + 1}`;

		const docSchema: any = {
			type: 'OBJECT',
			properties: {},
		};

		// Extraction schema
		if (extractionProperties.length > 0) {
			const extractionProps: Record<string, any> = {};

			for (const prop of extractionProperties) {
				let fieldSchema: any;

				if (includeEvidence) {
					// Wrap each field with value/evidence/confidence structure
					const valueProps: any = {
						value: {
							type: prop.type === 'date' ? 'STRING' : prop.type.toUpperCase(),
							description: prop.description || '',
							nullable: prop.nullable || false,
						},
						evidence: {
							type: 'STRING',
							description: 'Literal text excerpt from document (20-120 chars)',
							nullable: true,
						},
					};

					if (includeConfidence) {
						valueProps.confidence = {
							type: 'NUMBER',
							description: 'Confidence score 0.0-1.0',
							nullable: true,
						};
					}

					fieldSchema = {
						type: 'OBJECT',
						properties: valueProps,
					};
				} else {
					// Simple field without evidence
					fieldSchema = {
						type: prop.type === 'date' ? 'STRING' : prop.type.toUpperCase(),
						description: `${prop.description || ''} ${prop.type === 'date' ? '(Format: YYYY-MM-DD)' : ''}`.trim(),
						nullable: prop.nullable || false,
					};
				}

				extractionProps[prop.name] = fieldSchema;
			}

			docSchema.properties.extraction = {
				type: 'OBJECT',
				properties: extractionProps,
			};
		}

		// Classification schema
		if (enableClassification) {
			docSchema.properties.classification = {
				type: 'OBJECT',
				properties: {
					documentType: {
						type: 'STRING',
						description: 'Type of document identified',
					},
					isValid: {
						type: 'BOOLEAN',
						description: 'Whether the document meets classification requirements',
					},
					confidence: {
						type: 'NUMBER',
						description: 'Classification confidence 0.0-1.0',
					},
					reasoning: {
						type: 'STRING',
						description: 'Explanation of the classification decision',
					},
					missingFields: {
						type: 'ARRAY',
						items: { type: 'STRING' },
						description: 'Required fields that are missing (if invalid)',
					},
				},
			};
		}

		// Signatures schema
		if (detectSignatures) {
			docSchema.properties.signatures = {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						type: {
							type: 'STRING',
							description: 'Type of signature (manual, digital, stamp/seal)',
						},
						present: {
							type: 'BOOLEAN',
							description: 'Whether this signature type is present',
						},
						confidence: {
							type: 'NUMBER',
							description: 'Detection confidence 0.0-1.0',
						},
					},
				},
			};
		}

		documentSchemas[label] = docSchema;
	});

	// Root schema
	return {
		type: 'OBJECT',
		properties: {
			documents: {
				type: 'OBJECT',
				properties: documentSchemas,
			},
			summary: {
				type: 'OBJECT',
				properties: {
					totalDocuments: {
						type: 'INTEGER',
						description: 'Total number of documents processed',
					},
					validDocuments: {
						type: 'INTEGER',
						description: 'Number of documents that passed classification (if enabled)',
					},
					documentLabels: {
						type: 'ARRAY',
						items: { type: 'STRING' },
						description: 'List of all document labels',
					},
				},
			},
		},
	};
}

function buildMultimodalMultiDocumentPrompt(
	documents: Array<{ documentLabel?: string }>,
	extractionProperties: Array<any>,
	enableClassification: boolean,
	classificationRequirements: any,
	detectSignatures: boolean,
	includeEvidence: boolean,
): string {
	let prompt = 'You are analyzing multiple documents. For each document:\n\n';

	documents.forEach((doc, idx) => {
		const label = doc.documentLabel || `Document ${idx + 1}`;
		prompt += `### Document: "${label}"\n`;

		// Extraction instructions
		if (extractionProperties.length > 0) {
			prompt += `Extract the following fields from this document:\n`;
			extractionProperties.forEach((prop) => {
				prompt += `- ${prop.name}: ${prop.description || prop.type}\n`;
			});

			if (includeEvidence) {
				prompt += `\nFor each extracted field, provide:\n`;
				prompt += `  - value: The extracted value\n`;
				prompt += `  - evidence: Literal text excerpt from THIS document proving the value (20-120 characters preferred)\n`;
				prompt += `  - confidence: Your confidence score (0.0 to 1.0)\n`;
			}
		}

		// Classification instructions
		if (enableClassification && classificationRequirements) {
			prompt += `\nClassify this document according to these requirements:\n`;
			if (classificationRequirements.expectedType) {
				prompt += `  - Expected Document Type: ${classificationRequirements.expectedType}\n`;
			}
			if (classificationRequirements.requiredFields) {
				prompt += `  - Required Fields: ${classificationRequirements.requiredFields}\n`;
			}
			if (classificationRequirements.instructions) {
				prompt += `  - Classification Rules:\n`;
				const instructions = classificationRequirements.instructions.split('\n');
				instructions.forEach((inst: string) => {
					if (inst.trim()) prompt += `    ${inst.trim()}\n`;
				});
			}
			prompt += `\nReturn classification with: documentType, isValid, confidence, reasoning, missingFields (if any)\n`;
		}

		// Signature instructions
		if (detectSignatures) {
			prompt += `\nDetect signatures in this document:\n`;
			prompt += `  - Manual signatures (handwritten)\n`;
			prompt += `  - Digital signatures\n`;
			prompt += `  - Stamps or official seals\n`;
			prompt += `Return array of detected signatures with: type, present (true/false), confidence (0.0-1.0)\n`;
		}

		prompt += '\n';
	});

	prompt += 'IMPORTANT: Organize your response by document label in the specified JSON schema.\n';
	prompt +=
		'Each document should have its own section with extraction, classification, and signatures as applicable.\n';
	prompt += 'Include a summary section with totalDocuments, validDocuments, and documentLabels.';

	return prompt;
}

// Document type presets for common Brazilian documents
const DOCUMENT_PRESETS: Record<string, any> = {
	cpf: {
		schema: [
			{ name: 'nome', type: 'string', description: 'Nome completo', nullable: false },
			{ name: 'cpf', type: 'string', description: 'CPF no formato ###.###.###-##', nullable: false },
			{ name: 'dataNascimento', type: 'date', description: 'Data de nascimento', nullable: false },
			{ name: 'nomeMae', type: 'string', description: 'Nome da mãe', nullable: true },
			{ name: 'nomePai', type: 'string', description: 'Nome do pai', nullable: true },
		],
		classification: {
			expectedType: 'CPF',
			requiredFields: 'nome, cpf, dataNascimento',
			instructions: 'Must have "Receita Federal" or "República Federativa do Brasil" header\nCPF must be in format ###.###.###-##\nMust show birth date',
		},
	},
	rg: {
		schema: [
			{ name: 'nome', type: 'string', description: 'Nome completo', nullable: false },
			{ name: 'rg', type: 'string', description: 'Número do RG', nullable: false },
			{ name: 'cpf', type: 'string', description: 'CPF', nullable: true },
			{ name: 'dataNascimento', type: 'date', description: 'Data de nascimento', nullable: false },
			{ name: 'orgaoEmissor', type: 'string', description: 'Órgão emissor (SSP, etc)', nullable: true },
			{ name: 'dataEmissao', type: 'date', description: 'Data de emissão', nullable: true },
			{ name: 'nomeMae', type: 'string', description: 'Nome da mãe', nullable: true },
			{ name: 'nomePai', type: 'string', description: 'Nome do pai', nullable: true },
		],
		classification: {
			expectedType: 'RG',
			requiredFields: 'nome, rg, dataNascimento',
			instructions: 'Must have state seal or "Secretaria de Segurança Pública" header\nMust show RG number and issuing agency\nMust show birth date',
		},
	},
	cnh: {
		schema: [
			{ name: 'nome', type: 'string', description: 'Nome completo', nullable: false },
			{ name: 'cpf', type: 'string', description: 'CPF', nullable: false },
			{ name: 'numeroRegistro', type: 'string', description: 'Número do registro CNH', nullable: false },
			{ name: 'dataNascimento', type: 'date', description: 'Data de nascimento', nullable: false },
			{ name: 'categoria', type: 'string', description: 'Categoria (A, B, AB, etc)', nullable: false },
			{ name: 'dataEmissao', type: 'date', description: 'Data de emissão', nullable: true },
			{ name: 'validade', type: 'date', description: 'Data de validade', nullable: false },
		],
		classification: {
			expectedType: 'CNH',
			requiredFields: 'nome, cpf, numeroRegistro, categoria, validade',
			instructions: 'Must have "CNH" or "Carteira Nacional de Habilitação" header\nMust show license number and category\nMust show validity date',
		},
	},
	aso: {
		schema: [
			{ name: 'trabalhador', type: 'string', description: 'Nome do trabalhador', nullable: false },
			{ name: 'empresa', type: 'string', description: 'Nome da empresa', nullable: false },
			{ name: 'cargoTrabalhador', type: 'string', description: 'Cargo do trabalhador', nullable: true },
			{ name: 'dataExame', type: 'date', description: 'Data do exame', nullable: false },
			{ name: 'aptidao', type: 'string', description: 'Aptidão (APTO/INAPTO)', nullable: false },
			{ name: 'medicoResponsavel', type: 'string', description: 'Nome do médico responsável', nullable: false },
			{ name: 'crmMedico', type: 'string', description: 'CRM do médico', nullable: false },
		],
		classification: {
			expectedType: 'ASO',
			requiredFields: 'trabalhador, empresa, dataExame, aptidao, medicoResponsavel',
			instructions: 'Must have "ASO" or "Atestado de Saúde Ocupacional" in title\nMust show employee name, company, exam date\nMust show "APTO" or "INAPTO" status\nMust have doctor signature and CRM',
		},
	},
	passport: {
		schema: [
			{ name: 'nome', type: 'string', description: 'Full name', nullable: false },
			{ name: 'numeroPassaporte', type: 'string', description: 'Passport number', nullable: false },
			{ name: 'nacionalidade', type: 'string', description: 'Nationality', nullable: false },
			{ name: 'dataNascimento', type: 'date', description: 'Date of birth', nullable: false },
			{ name: 'dataEmissao', type: 'date', description: 'Issue date', nullable: false },
			{ name: 'dataValidade', type: 'date', description: 'Expiry date', nullable: false },
		],
		classification: {
			expectedType: 'Passport',
			requiredFields: 'nome, numeroPassaporte, nacionalidade, dataNascimento',
			instructions: 'Must have "Passport" or "Passaporte" header\nMust show passport number, nationality, and personal data\nMust show issue and expiry dates',
		},
	},
	ctps: {
		schema: [
			{ name: 'nome', type: 'string', description: 'Nome completo', nullable: false },
			{ name: 'numeroCTPS', type: 'string', description: 'Número da CTPS', nullable: false },
			{ name: 'serie', type: 'string', description: 'Série', nullable: false },
			{ name: 'dataNascimento', type: 'date', description: 'Data de nascimento', nullable: false },
			{ name: 'dataEmissao', type: 'date', description: 'Data de emissão', nullable: true },
		],
		classification: {
			expectedType: 'CTPS',
			requiredFields: 'nome, numeroCTPS, serie, dataNascimento',
			instructions: 'Must have "Carteira de Trabalho" or "CTPS" header\nMust show CTPS number and series\nMust show birth date',
		},
	},
};

// Schema templates for compareDocuments operation
const SCHEMA_TEMPLATES: Record<string, any[]> = {
	brazilian_id: [
		{ name: 'nome', type: 'string', description: 'Full name', nullable: false },
		{ name: 'cpf', type: 'string', description: 'CPF number', nullable: true },
		{ name: 'rg', type: 'string', description: 'RG number', nullable: true },
		{ name: 'cnh', type: 'string', description: 'CNH number', nullable: true },
		{ name: 'dataNascimento', type: 'date', description: 'Birth date', nullable: false },
		{ name: 'nomeMae', type: 'string', description: 'Mother name', nullable: true },
		{ name: 'orgaoEmissor', type: 'string', description: 'Issuing agency', nullable: true },
	],
	medical: [
		{ name: 'trabalhador', type: 'string', description: 'Worker name', nullable: false },
		{ name: 'empresa', type: 'string', description: 'Company name', nullable: false },
		{ name: 'dataExame', type: 'date', description: 'Exam date', nullable: false },
		{ name: 'aptidao', type: 'string', description: 'Fitness status', nullable: false },
		{ name: 'medicoResponsavel', type: 'string', description: 'Doctor name', nullable: false },
		{ name: 'crmMedico', type: 'string', description: 'Doctor CRM', nullable: true },
	],
	work: [
		{ name: 'nome', type: 'string', description: 'Employee name', nullable: false },
		{ name: 'empresa', type: 'string', description: 'Company name', nullable: false },
		{ name: 'cargo', type: 'string', description: 'Job title', nullable: true },
		{ name: 'dataAdmissao', type: 'date', description: 'Hire date', nullable: true },
		{ name: 'salario', type: 'number', description: 'Salary', nullable: true },
	],
};

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
				{
					name: 'Compare Documents',
					value: 'compareDocuments',
					description: 'Compare and validate multiple documents',
					action: 'Compare and validate multiple documents',
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

			// Advanced Prompt Mode (for multimodal, compareDocuments, validateDocument)
			{
				displayName: 'Advanced Prompt Mode',
				name: 'advancedPromptMode',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['multimodal', 'compareDocuments', 'validateDocument'],
					},
				},
				description:
					'Hide all structured configuration fields and define everything via prompt. Shows only: Text/Prompt, Files/Documents/Data, Response Format, and Options.',
			},

			// Document Type Preset (for multimodal and compareDocuments)
			{
				displayName: 'Document Type Preset',
				name: 'documentPreset',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['multimodal'],
					},
					hide: {
						advancedPromptMode: [true],
					},
				},
				options: [
					{ name: 'None (Manual Configuration)', value: 'none' },
					{ name: 'CPF (Cadastro de Pessoa Física)', value: 'cpf' },
					{ name: 'RG (Registro Geral)', value: 'rg' },
					{ name: 'CNH (Carteira Nacional de Habilitação)', value: 'cnh' },
					{ name: 'Passport (Passaporte)', value: 'passport' },
					{ name: 'ASO (Atestado de Saúde Ocupacional)', value: 'aso' },
					{ name: 'CTPS (Carteira de Trabalho)', value: 'ctps' },
				],
				default: 'none',
				description: 'Select a document type to auto-populate extraction schema and classification rules',
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
					hide: {
						advancedPromptMode: [true],
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
					hide: {
						advancedPromptMode: [true],
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
				displayOptions: {
					hide: {
						advancedPromptMode: [true],
					},
				},
			},

			// Multimodal
			{
				displayName: 'Text Prompt',
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
				placeholder: 'Analyze these documents and extract...',
				description: 'The text prompt to send with the files. If empty and schema is defined, auto-generates extraction prompt.',
			},
			{
				displayName: 'Files',
				name: 'multimodalFiles',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				displayOptions: {
					show: {
						operation: ['multimodal'],
					},
				},
				description: 'Upload one or more files to process (1-10 files)',
				options: [
					{
						name: 'files',
						displayName: 'File',
						values: [
							{
								displayName: 'Document Label',
								name: 'documentLabel',
								type: 'string',
								default: '',
								placeholder: 'CPF, RG, Invoice, etc.',
								description:
									'Optional label to identify this document in outputs and prompts. Auto-generates "Document 1", "Document 2", etc. if empty.',
							},
							{
								displayName: 'File Source',
								name: 'fileSource',
								type: 'options',
								options: [
									{ name: 'Binary Data', value: 'binary' },
									{ name: 'URL', value: 'url' },
									{ name: 'Base64', value: 'base64' },
								],
								default: 'binary',
							},
							{
								displayName: 'Binary Property',
								name: 'binaryProperty',
								type: 'string',
								default: 'data',
								displayOptions: {
									show: {
										fileSource: ['binary'],
									},
								},
								description: 'Name of the binary property containing the file',
							},
							{
								displayName: 'File URL',
								name: 'fileUrl',
								type: 'string',
								default: '',
								displayOptions: {
									show: {
										fileSource: ['url'],
									},
								},
								description: 'URL of the file to process',
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
										fileSource: ['url'],
									},
								},
							},
							{
								displayName: 'Base64 File Data',
								name: 'base64File',
								type: 'string',
								default: '',
								displayOptions: {
									show: {
										fileSource: ['base64'],
									},
								},
								description: 'Base64 encoded file data (without data:* prefix)',
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
										fileSource: ['base64'],
									},
								},
							},
						],
					},
				],
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
				hide: {
					advancedPromptMode: [true],
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
				hide: {
					advancedPromptMode: [true],
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
				hide: {
					advancedPromptMode: [true],
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
					hide: {
						advancedPromptMode: [true],
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
								default: 'normalized',
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
					hide: {
						advancedPromptMode: [true],
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

		// Compare Documents - Documents to Compare
		{
			displayName: 'Documents to Compare',
			name: 'documentsToCompare',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
			},
			default: {},
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
			},
			description: 'Upload multiple documents to compare (2-10 documents)',
			options: [
				{
					name: 'documents',
					displayName: 'Document',
					values: [
						{
							displayName: 'Document Label',
							name: 'documentLabel',
							type: 'string',
							default: '',
							placeholder: 'CPF, RG, CNH, etc.',
							description: 'Human-readable label for this document (used in comparison rules)',
						},
						{
							displayName: 'Document Type',
							name: 'documentType',
							type: 'string',
							default: '',
							placeholder: 'CPF, RG, Medical Certificate, etc.',
							description: 'Expected document type (optional, for classification)',
						},
						{
							displayName: 'File Source',
							name: 'fileSource',
							type: 'options',
							options: [
								{ name: 'Binary Data', value: 'binary' },
								{ name: 'URL', value: 'url' },
								{ name: 'Base64', value: 'base64' },
							],
							default: 'binary',
						},
						{
							displayName: 'Binary Property',
							name: 'binaryProperty',
							type: 'string',
							default: 'data',
							displayOptions: {
								show: {
									fileSource: ['binary'],
								},
							},
							description: 'Name of the binary property containing the file',
						},
						{
							displayName: 'File URL',
							name: 'fileUrl',
							type: 'string',
							default: '',
							displayOptions: {
								show: {
									fileSource: ['url'],
								},
							},
							description: 'URL of the file to process',
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
									fileSource: ['url'],
								},
							},
						},
						{
							displayName: 'Base64 File Data',
							name: 'base64File',
							type: 'string',
							default: '',
							displayOptions: {
								show: {
									fileSource: ['base64'],
								},
							},
							description: 'Base64 encoded file data (without data:* prefix)',
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
									fileSource: ['base64'],
								},
							},
						},
					],
				},
			],
		},

		// Compare Documents - Schema Template
		{
			displayName: 'Schema Template',
			name: 'schemaTemplate',
			type: 'options',
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
				hide: {
					advancedPromptMode: [true],
				},
			},
			options: [
				{ name: 'None (Define Manually)', value: 'none' },
				{ name: 'Brazilian ID Documents (CPF, RG, CNH)', value: 'brazilian_id' },
				{ name: 'Medical Documents (ASO, Certificates)', value: 'medical' },
				{ name: 'Work Documents (CTPS, Contract)', value: 'work' },
			],
			default: 'none',
			description: 'Select a template to auto-populate extraction schema for all documents',
		},

		// Compare Documents - Extraction Schema
		{
			displayName: 'Extraction Schema',
			name: 'extractionSchema',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
			},
			default: {},
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
				hide: {
					advancedPromptMode: [true],
				},
			},
			description: 'Define what fields to extract from each document',
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
							placeholder: 'nome, cpf, rg, dataNascimento, ...',
							description: 'Name of the field to extract',
						},
						{
							displayName: 'Type',
							name: 'type',
							type: 'options',
							options: [
								{ name: 'String', value: 'string' },
								{ name: 'Number', value: 'number' },
								{ name: 'Integer', value: 'integer' },
								{ name: 'Date (YYYY-MM-DD)', value: 'date' },
							],
							default: 'string',
							description: 'The type of this property',
						},
						{
							displayName: 'Description',
							name: 'description',
							type: 'string',
							default: '',
							placeholder: 'Full name of the person, ...',
							description: 'Field description to help the model understand what to extract',
						},
						{
							displayName: 'Nullable',
							name: 'nullable',
							type: 'boolean',
							default: true,
							description: 'Whether null is allowed when field is not found',
						},
					],
				},
			],
		},

		// Compare Documents - Auto-Generation Notice
		{
			displayName: 'Tip: Leave comparison rules empty to auto-generate them from the extraction schema',
			name: 'autoGenerateNotice',
			type: 'notice',
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
			},
			default: '',
		},

		// Compare Documents - Field Comparison Rules
		{
			displayName: 'Field Comparison Rules',
			name: 'fieldComparisonRules',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
			},
			default: {},
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
				hide: {
					advancedPromptMode: [true],
				},
			},
			description: 'Compare specific fields across documents (e.g., name in CPF must match name in RG)',
			options: [
				{
					name: 'comparisons',
					displayName: 'Comparison',
					values: [
						{
							displayName: 'Source Document',
							name: 'sourceDocument',
							type: 'string',
							default: '',
							placeholder: 'CPF, RG, etc.',
							description: 'Label of the first document (as defined above)',
						},
						{
							displayName: 'Source Field',
							name: 'sourceField',
							type: 'string',
							default: '',
							placeholder: 'nome, cpf, etc.',
							description: 'Field name in the source document',
						},
						{
							displayName: 'Target Document',
							name: 'targetDocument',
							type: 'string',
							default: '',
							placeholder: 'RG, CNH, etc.',
							description: 'Label of the second document',
						},
						{
							displayName: 'Target Field',
							name: 'targetField',
							type: 'string',
							default: '',
							placeholder: 'nome, rg, etc.',
							description: 'Field name in the target document',
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
							default: 'normalized',
							description: 'How to compare the values',
						},
						{
							displayName: 'Error Message',
							name: 'errorMessage',
							type: 'string',
							default: '',
							placeholder: 'Nome divergente entre CPF e RG',
							description: 'Custom error message if comparison fails',
						},
					],
				},
			],
		},

		// Compare Documents - Custom Cross-Document Rules
		{
			displayName: 'Custom Cross-Document Rules',
			name: 'customCrossDocumentRules',
			type: 'fixedCollection',
			typeOptions: {
				multipleValues: true,
			},
			default: {},
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
				hide: {
					advancedPromptMode: [true],
				},
			},
			description: 'Custom validation rules involving multiple documents',
			options: [
				{
					name: 'rules',
					displayName: 'Rule',
					values: [
						{
							displayName: 'Rule Name',
							name: 'ruleName',
							type: 'string',
							default: '',
							placeholder: 'Age consistency check, Date validation, etc.',
							description: 'Name of the rule',
						},
						{
							displayName: 'Rule Description',
							name: 'ruleDescription',
							type: 'string',
							typeOptions: {
								rows: 3,
							},
							default: '',
							placeholder: 'dataEmissao in CNH must be >= dataNascimento in CPF\nidade in Medical Certificate must match calculated age from dataNascimento in RG',
							description: 'Natural language description of the rule. Reference documents by their labels.',
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
							placeholder: 'Data de emissão inconsistente entre documentos',
							description: 'Message to show if rule fails',
						},
					],
				},
			],
		},

		// Compare Documents - Enable Auto-Detection
		{
			displayName: 'Enable Auto-Detection of Inconsistencies',
			name: 'enableAutoDetection',
			type: 'boolean',
			default: true,
			displayOptions: {
				show: {
					operation: ['compareDocuments'],
				},
				hide: {
					advancedPromptMode: [true],
				},
			},
			description: 'Let AI automatically find discrepancies across documents beyond explicit rules',
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
					hide: {
						advancedPromptMode: [true],
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

				let schemaProperties = this.getNodeParameter('schemaProperties', i, {}) as {
					properties?: SchemaProperty[];
				};
				const responseSchema = this.getNodeParameter('responseSchema', i, '') as string;

				// Handle Document Type Preset for multimodal operation
				if (operation === 'multimodal') {
					const documentPreset = this.getNodeParameter('documentPreset', i, 'none') as string;
					if (documentPreset && documentPreset !== 'none' && DOCUMENT_PRESETS[documentPreset]) {
						const preset = DOCUMENT_PRESETS[documentPreset];

						// If no manual schema properties defined, use preset schema
						if (!schemaProperties?.properties || schemaProperties.properties.length === 0) {
							schemaProperties = {
								properties: preset.schema.map((field: any) => ({
									name: field.name,
									type: field.type,
									description: field.description,
									nullable: field.nullable,
								})),
							};
						}
					}
				}

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
							'- 0.9ar -1.0: clelabel + value. 0.6-0.8: present but noisy. 0.1-0.5: uncertain. If very uncertain, return nulls.',
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

				// Declare contents variable for all operations
				let contents: Content[];

				// Handle validateDocument operation
				if (operation === 'validateDocument') {
					const extractedDataParam = this.getNodeParameter('extractedData', i) as any;
					const extractedData = typeof extractedDataParam === 'string'
						? JSON.parse(extractedDataParam)
						: extractedDataParam;

					// Check for Advanced Prompt Mode
					const advancedPromptModeValidate = this.getNodeParameter('advancedPromptMode', i, false) as boolean;

					if (advancedPromptModeValidate) {
						// Advanced mode: user defines everything in the prompt
						const text = this.getNodeParameter('text', i, '') as string;

						if (!text) {
							throw new NodeOperationError(
								this.getNode(),
								'Text prompt is required in Advanced Prompt Mode. Define validation rules and comparisons directly in your prompt.',
								{ itemIndex: i },
							);
						}

						// Build validation prompt with extracted data context
						const validationPrompt = `${text}\n\nExtracted Data to Validate:\n${JSON.stringify(extractedData, null, 2)}`;

						contents = [
							{
								role: 'user',
								parts: [{ text: validationPrompt }],
							},
						];

						// Note: Schema is already set from responseFormat/schemaMode if user defined one
					} else {
						// Normal structured mode: use reference data and custom rules

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

				} // End of else block (normal structured mode for validateDocument)

					continue;
				}


				// Handle compareDocuments operation
				if (operation === 'compareDocuments') {
					const documentsParam = this.getNodeParameter('documentsToCompare', i, {}) as {
						documents?: Array<any>;
					};
					const documents = documentsParam.documents || [];

					if (documents.length < 2) {
						throw new NodeOperationError(
							this.getNode(),
							'At least 2 documents are required for comparison',
							{ itemIndex: i },
						);
					}

					if (documents.length > 10) {
						throw new NodeOperationError(
							this.getNode(),
							'Maximum 10 documents supported for comparison',
							{ itemIndex: i },
						);
					}

					// Check for Advanced Prompt Mode
					const advancedPromptModeCompare = this.getNodeParameter('advancedPromptMode', i, false) as boolean;

					if (advancedPromptModeCompare) {
						// Advanced mode: user defines everything in the prompt
						const text = this.getNodeParameter('text', i, '') as string;

						if (!text) {
							throw new NodeOperationError(
								this.getNode(),
								'Text prompt is required in Advanced Prompt Mode. Define what to extract, comparison rules, and validation logic directly in your prompt.',
								{ itemIndex: i },
							);
						}

						// Build file parts
						const fileParts = await buildFileParts(this, documents, i);

						// Simple contents with user's prompt
						contents = [
							{
								role: 'user',
								parts: [{ text }, ...fileParts],
							},
						];

						// Note: Schema is already set from responseFormat/schemaMode if user defined one
					} else {
						// Normal structured mode: use templates, auto-generation, etc.

						const extractionSchemaParam = this.getNodeParameter('extractionSchema', i, {}) as {
						properties?: Array<any>;
					};
					let extractionProperties = extractionSchemaParam.properties || [];

					// Handle Schema Template
					const schemaTemplate = this.getNodeParameter('schemaTemplate', i, 'none') as string;
					if (schemaTemplate && schemaTemplate !== 'none' && SCHEMA_TEMPLATES[schemaTemplate]) {
						// If no manual properties defined, use template
						if (extractionProperties.length === 0) {
							extractionProperties = SCHEMA_TEMPLATES[schemaTemplate];
						}
					}

					if (extractionProperties.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'At least one extraction property is required',
							{ itemIndex: i },
						);
					}

					const fieldComparisonRulesParam = this.getNodeParameter('fieldComparisonRules', i, {}) as {
						comparisons?: Array<any>;
					};
					let fieldComparisons = fieldComparisonRulesParam.comparisons || [];

					// Auto-generate comparison rules if none provided
					if (fieldComparisons.length === 0 && extractionProperties.length > 0 && documents.length >= 2) {
						// Generate comparison rules for common fields across all documents
						const autoComparisons: Array<any> = [];

						for (const property of extractionProperties) {
							const fieldName = property.name;
							const fieldType = property.type;

							// Determine comparison type based on field type and name
							let comparisonType = 'normalized'; // default
							if (fieldType === 'number' || fieldType === 'integer') {
								comparisonType = 'numeric';
							} else if (fieldType === 'date') {
								comparisonType = 'date';
							} else if (['cpf', 'rg', 'cnh', 'cnpj'].includes(fieldName.toLowerCase())) {
								comparisonType = 'numeric'; // Brazilian IDs should use numeric comparison
							}

							// Create comparisons between all pairs of documents
							for (let docIdx = 0; docIdx < documents.length - 1; docIdx++) {
								const sourceDoc = documents[docIdx];
								const targetDoc = documents[docIdx + 1];

								autoComparisons.push({
									sourceDocument: sourceDoc.documentLabel || `Document ${docIdx + 1}`,
									sourceField: fieldName,
									targetDocument: targetDoc.documentLabel || `Document ${docIdx + 2}`,
									targetField: fieldName,
									comparisonType,
									errorMessage: `Campo '${fieldName}' divergente entre documentos`,
								});
							}
						}

						fieldComparisons = autoComparisons;
					}

					const customCrossDocumentRulesParam = this.getNodeParameter('customCrossDocumentRules', i, {}) as {
						rules?: Array<any>;
					};
					const customRules = customCrossDocumentRulesParam.rules || [];

					const enableAutoDetection = this.getNodeParameter('enableAutoDetection', i, true) as boolean;

					// Build file parts
					const fileParts = await buildFileParts(this, documents, i);

					// Build prompt and schema
					const comparisonPrompt = buildMultiDocumentComparisonPrompt(
						documents,
						fieldComparisons,
						customRules,
						enableAutoDetection,
					);

					const comparisonSchema = buildMultiDocumentComparisonSchema(
						documents,
						extractionProperties,
						enableAutoDetection,
					);

					// Create model for comparison
					const comparisonModel = vertexAI.getGenerativeModel({
						model,
						generationConfig: {
							maxOutputTokens: options.maxOutputTokens || 4096,
							temperature: 0.2,
							topP: 0.95,
							topK: 40,
							responseMimeType: 'application/json',
							responseSchema: comparisonSchema,
						},
					});

					// Build contents with text prompt and all file parts
					const compareContents: Content[] = [
						{
							role: 'user',
							parts: [
								{ text: comparisonPrompt },
								...fileParts,
							],
						},
					];

					// Generate comparison result with timeout
					const timeoutMs = options.timeout || 120000;
					const comparePromise = comparisonModel.generateContent({ contents: compareContents });

					const timeoutPromise = new Promise<never>((_, reject) => {
						setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
					});

					const comparisonResult = await Promise.race([comparePromise, timeoutPromise]);
					const comparisonResponse = comparisonResult.response;

					const comparisonText = concatTextFromResponse(comparisonResponse);
					const comparisonJson = tryParseJson(comparisonText);

					returnData.push({
						json: {
							comparison: comparisonJson,
							text: comparisonText,
							model,
							operation,
							documentCount: documents.length,
							usage: comparisonResponse?.usageMetadata,
						},
					});

					} // End of else block (normal structured mode for compareDocuments)

					continue;
				}

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
					// Multimodal with multiple files
					const text = this.getNodeParameter('text', i, '') as string;
					const filesParam = this.getNodeParameter('multimodalFiles', i, {}) as {
						files?: Array<any>;
					};
					const files = filesParam.files || [];

					if (files.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'At least one file is required for multimodal operation',
							{ itemIndex: i },
						);
					}

					if (files.length > 10) {
						throw new NodeOperationError(
							this.getNode(),
							'Maximum 10 files supported for multimodal operation',
							{ itemIndex: i },
						);
					}

					// Check for Advanced Prompt Mode
					const advancedPromptMode = this.getNodeParameter('advancedPromptMode', i, false) as boolean;

					if (advancedPromptMode) {
						// Advanced mode: user defines everything in the prompt
						if (!text) {
							throw new NodeOperationError(
								this.getNode(),
								'Text prompt is required in Advanced Prompt Mode. Define extraction fields, classification rules, signature detection, and output format directly in your prompt.',
								{ itemIndex: i },
							);
						}

						// Build file parts
						const fileParts = await buildFileParts(this, files, i);

						// Simple contents with user's prompt
						contents = [
							{
								role: 'user',
								parts: [{ text }, ...fileParts],
							},
						];

						// Note: Schema is already set from responseFormat/schemaMode if user defined one
						// Otherwise it will be free-form JSON or text based on responseFormat
					} else {
						// Normal structured mode: use presets, multi-document schema, etc.

						// Generate document labels
					const documentsWithLabels = files.map((file, idx) => ({
						...file,
						documentLabel: file.documentLabel || `Document ${idx + 1}`,
					}));

					// Check if multi-document mode is needed
					const enableClassificationMulti = this.getNodeParameter('enableClassification', i, false) as boolean;
					const detectSignaturesMulti = this.getNodeParameter('detectSignatures', i, false) as boolean;
					const includeEvidenceMulti = this.getNodeParameter('includeEvidence', i, false) as boolean;

					const isMultiDocumentMode =
						files.length > 1 &&
						responseFormat === 'application/json' &&
						(enableClassificationMulti || detectSignaturesMulti || includeEvidenceMulti);

					// Build file parts using shared function
					const fileParts = await buildFileParts(this, documentsWithLabels, i);

					// Determine prompt text and schema
					let promptText = text;

					if (isMultiDocumentMode) {
						// Multi-document mode: use specialized schema and prompt
						const classificationRequirementsParam = this.getNodeParameter(
							'classificationRequirements',
							i,
							{},
						) as any;
						const classificationRequirements = classificationRequirementsParam?.requirements;

						const multiDocSchema = buildMultimodalMultiDocumentSchema(
							documentsWithLabels,
							schemaProperties?.properties || [],
							enableClassificationMulti,
							classificationRequirements,
							detectSignaturesMulti,
							includeEvidenceMulti,
							includeConfidence,
						);

						const multiDocPrompt = buildMultimodalMultiDocumentPrompt(
							documentsWithLabels,
							schemaProperties?.properties || [],
							enableClassificationMulti,
							classificationRequirements,
							detectSignaturesMulti,
							includeEvidenceMulti,
						);

						// Override schema with multi-document schema
						generationConfig.responseSchema = multiDocSchema;

						// Use multi-document prompt if no custom text provided
						if (!text) {
							promptText = multiDocPrompt;
						} else {
							// Prepend multi-document instructions to custom text
							promptText = `${multiDocPrompt}\n\nAdditional Instructions:\n${text}`;
						}
					} else {
						// Single document or simple extraction - use existing logic
						if (!promptText && responseFormat === 'application/json' && schemaProperties?.properties) {
							// Auto-generate extraction prompt from schema
							const fieldNames = schemaProperties.properties.map((p: any) => p.name).join(', ');
							promptText = `Extract the following fields from the document(s): ${fieldNames}`;
						} else if (!promptText) {
							promptText = 'Analyze these files and extract relevant information.';
						}
					}

					contents = [
						{
							role: 'user',
							parts: [{ text: promptText }, ...fileParts],
						},
					];
					} // End of else block (normal structured mode)
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
