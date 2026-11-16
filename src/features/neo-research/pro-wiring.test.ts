import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import appSource from '../../App.tsx?raw';
import { BLOCK_META } from '../../lib/workspace';

describe('full Pro Neo research entry configuration', () => {
    it('explicitly selects real/latest at the workspace adapter instead of inheriting fixture defaults', () => {
        const source = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const adapters: ts.JsxSelfClosingElement[] = [];
        const walk = (node: ts.Node) => {
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'NeoContractResearchPanel') adapters.push(node);
            ts.forEachChild(node, walk);
        };
        walk(source);
        expect(adapters).toHaveLength(1);
        const attributes = Object.fromEntries(adapters[0]!.attributes.properties
            .filter(ts.isJsxAttribute).map(attribute => [attribute.name.getText(source), attribute.initializer]));
        expect(attributes.sourceMode && ts.isStringLiteral(attributes.sourceMode) && attributes.sourceMode.text).toBe('real');
        expect(attributes.financeMode && ts.isStringLiteral(attributes.financeMode) && attributes.financeMode.text).toBe('latest');
        expect(attributes.contract?.getText(source)).toBe('{contract}');
    });
    it('describes the real financial and replay sources separately in the block picker', () => {
        expect(BLOCK_META['neo-research'].description).toContain('真實財務');
        expect(BLOCK_META['neo-research'].description).toContain('歷史重播時點分別標示');
        expect(BLOCK_META['neo-research'].description).not.toMatch(/合成|示範/);
    });
});
