import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const readmePath = path.join(ROOT, 'README.md');
const projectSummaryPath = path.join(ROOT, 'PROJECT-SUMMARY.md');

describe('README structure', () => {
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');
  const readmeLines = readmeContent.split('\n');

  it('contains required sections in correct order', () => {
    const whyIndex = readmeContent.indexOf('## Why Datasense?');
    const quickStartIndex = readmeContent.indexOf('## Quick Start');
    const coreFeaturesIndex = readmeContent.indexOf('## Core Features');
    const advancedFeaturesIndex = readmeContent.indexOf('## Advanced Features');
    const fullDocIndex = readmeContent.indexOf('## Full Documentation');

    expect(whyIndex).toBeGreaterThan(-1);
    expect(quickStartIndex).toBeGreaterThan(-1);
    expect(coreFeaturesIndex).toBeGreaterThan(-1);
    expect(advancedFeaturesIndex).toBeGreaterThan(-1);
    expect(fullDocIndex).toBeGreaterThan(-1);

    expect(whyIndex).toBeLessThan(quickStartIndex);
    expect(quickStartIndex).toBeLessThan(coreFeaturesIndex);
    expect(coreFeaturesIndex).toBeLessThan(advancedFeaturesIndex);
    expect(advancedFeaturesIndex).toBeLessThan(fullDocIndex);
  });

  it('has line count ≤ 150', () => {
    expect(readmeLines.length).toBeLessThanOrEqual(150);
  });

  it('Quick Start has exactly 3 numbered steps', () => {
    const quickStartIndex = readmeLines.findIndex(line => line.startsWith('## Quick Start'));
    // Find the next section heading after Quick Start
    const nextSectionIndex = readmeLines.findIndex(
      (line, i) => i > quickStartIndex && line.startsWith('## ')
    );
    const quickStartSection = readmeLines.slice(quickStartIndex, nextSectionIndex);
    const numberedSteps = quickStartSection.filter(line => /^\d+\.\s/.test(line.trim()));
    expect(numberedSteps).toHaveLength(3);
  });

  it('Core Features has exactly 5 items', () => {
    const coreFeaturesIndex = readmeLines.findIndex(line => line.startsWith('## Core Features'));
    const nextSectionIndex = readmeLines.findIndex(
      (line, i) => i > coreFeaturesIndex && line.startsWith('## ')
    );
    const coreFeaturesSection = readmeLines.slice(coreFeaturesIndex, nextSectionIndex);
    // Core Features uses a markdown table — count data rows (exclude header and separator)
    const tableRows = coreFeaturesSection.filter(
      line => line.trim().startsWith('|') && !line.includes('---') && !line.includes('Feature')
    );
    expect(tableRows).toHaveLength(5);
  });
});

describe('PROJECT-SUMMARY structure', () => {
  const summaryContent = fs.readFileSync(projectSummaryPath, 'utf-8');

  it('contains Executive Summary section', () => {
    expect(summaryContent).toContain('## Executive Summary');
  });

  it('contains Current Status section', () => {
    expect(summaryContent).toContain('## Current Status');
  });

  it('contains Known Limitations section', () => {
    expect(summaryContent).toContain('## Known Limitations');
  });
});
