import { Log } from '../util/log';

const log = Log.create('Preview');

const maxProperties = 5;
const maxArrayItems = 5;
const maxStringChars = 20;
const maxAttributes = 5;

export function renderPreview(objectGrip: FirefoxDebugProtocol.ObjectGrip): string {
	try {

		const preview = objectGrip.preview;
		if (!preview) {
			return objectGrip.class;
		}

		if (preview.kind === 'Object') {

			return renderObjectPreview(preview, objectGrip.class);

		} else if (preview.kind === 'ArrayLike') {

			return renderArrayLikePreview(preview);

		} else if ((objectGrip.class === 'Date') && (preview.kind === undefined)) {

			const date = new Date(preview.timestamp);
			return date.toString();

		} else if (preview.kind === 'ObjectWithURL') {

			return `${objectGrip.class} ${preview.url}`;

		} else if (preview.kind === 'DOMNode') {

			return renderDOMNodePreview(preview);

		} else if (preview.kind === 'Error') {

			return `${objectGrip.class}: ${preview.message}`;

		} else {

			return objectGrip.class;

		}

	} catch (e) {
		log.error(`renderPreview failed for ${JSON.stringify(objectGrip)}: ${e}`);
		return '';
	}
}

function renderObjectPreview(preview: FirefoxDebugProtocol.ObjectPreview, className: string): string {

	const renderedProperties: string[] = [];
	let i = 0;
	for (const property in preview.ownProperties) {

		const renderedValue = renderGrip(preview.ownProperties[property].value);
		renderedProperties.push(`${property}: ${renderedValue}`);

		if (++i >= maxProperties) {
			renderedProperties.push('...');
			break;
		}
	}

	const renderedObject = `{${renderedProperties.join(', ')}}`;

	if (className === 'Object') {
		return renderedObject;
	} else {
		return `${className} ${renderedObject}`;
	}
}

function renderDOMNodePreview(preview: FirefoxDebugProtocol.DOMNodePreview): string {

	if (!preview.attributes) {
		return `<${preview.nodeName}>`;
	}

	const renderedAttributes: string[] = [];
	let i = 0;
	for (const attribute in preview.attributes) {

		const renderedValue = renderGrip(preview.attributes[attribute]);
		renderedAttributes.push(`${attribute}="${renderedValue}"`);

		if (++i >= maxAttributes) {
			renderedAttributes.push('...');
			break;
		}
	}

	if (renderedAttributes.length === 0) {
		return `<${preview.nodeName}>`;
	} else {
		return `<${preview.nodeName} ${renderedAttributes.join(' ')}>`;
	}
}

function renderArrayLikePreview(preview: FirefoxDebugProtocol.ArrayLikePreview): string {

	let result = `Array(${preview.length})`;

	if (preview.items && preview.items.length > 0) {

		const renderCount = Math.min(preview.items.length, maxArrayItems);
		const itemsToRender = preview.items.slice(0, renderCount);
		const renderedItems = itemsToRender.map(item => renderGrip(item));

		if (renderCount < preview.items.length) {
			renderedItems.push('...');
		}

		result += ` [${renderedItems.join(', ')}]`;

	}

	return result;
}

function renderGrip(grip: FirefoxDebugProtocol.Grip): string {

	if ((typeof grip === 'boolean') || (typeof grip === 'number')) {

		return grip.toString();

	} else if (typeof grip === 'string') {

		if (grip.length > maxStringChars) {
			return `"${grip.substr(0, maxStringChars)}..."`;
		} else {
			return `"${grip}"`;
		}

	} else {

		switch (grip.type) {

			case 'null':
			case 'undefined':
			case 'Infinity':
			case '-Infinity':
			case 'NaN':
			case '-0':

				return grip.type;

			case 'longString':

				const initial = (<FirefoxDebugProtocol.LongStringGrip>grip).initial;
				if (initial.length > maxStringChars) {
					return `${initial.substr(0, maxStringChars)}...`;
				} else {
					return initial;
				}
		
			case 'symbol':

				let symbolName = (<FirefoxDebugProtocol.SymbolGrip>grip).name;
				return `Symbol(${symbolName})`;

			case 'object':

				let objectGrip = <FirefoxDebugProtocol.ObjectGrip>grip;
				return renderPreview(objectGrip);

			default:

				log.warn(`Unexpected object grip of type ${grip.type}: ${JSON.stringify(grip)}`);
				return '';

		}
	}
}
