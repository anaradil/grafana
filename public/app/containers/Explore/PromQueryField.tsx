import React from 'react';

// dom also includes Element polyfills
import { getNextCharacter, getPreviousCousin } from './utils/dom';
import PluginPrism, { setPrismTokens } from './slate-plugins/prism/index';
import PrismPromql from './slate-plugins/prism/promql';
import RunnerPlugin from './slate-plugins/runner';
import { processLabels, RATE_RANGES, cleanText } from './utils/prometheus';

import TypeaheadField, { SuggestionGroup, TypeaheadInput, TypeaheadFieldState, TypeaheadOutput } from './QueryField';

const EMPTY_METRIC = '';
const METRIC_MARK = 'metric';
const PRISM_LANGUAGE = 'promql';

const wrapText = text => ({ text });

function willApplySuggestion(suggestion: string, { typeaheadContext, typeaheadText }: TypeaheadFieldState): string {
  // Modify suggestion based on context
  switch (typeaheadContext) {
    case 'context-labels': {
      const nextChar = getNextCharacter();
      if (!nextChar || nextChar === '}' || nextChar === ',') {
        suggestion += '=';
      }
      break;
    }

    case 'context-label-values': {
      // Always add quotes and remove existing ones instead
      if (!(typeaheadText.startsWith('="') || typeaheadText.startsWith('"'))) {
        suggestion = `"${suggestion}`;
      }
      if (getNextCharacter() !== '"') {
        suggestion = `${suggestion}"`;
      }
      break;
    }

    default:
  }
  return suggestion;
}

class PromQueryField extends React.Component<any, any> {
  plugins: any[];

  constructor(props, context) {
    super(props, context);

    this.plugins = [
      RunnerPlugin({ handler: props.onPressEnter }),
      PluginPrism({ definition: PrismPromql, language: PRISM_LANGUAGE }),
    ];

    this.state = {
      labelKeys: {},
      labelValues: {},
      metrics: props.metrics || [],
    };
  }

  componentDidMount() {
    this.fetchMetricNames();
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.metrics && nextProps.metrics !== this.props.metrics) {
      this.setState({ metrics: nextProps.metrics }, this.onMetricsReceived);
    }
  }

  onMetricsReceived = () => {
    if (!this.state.metrics) {
      return;
    }
    setPrismTokens(PRISM_LANGUAGE, METRIC_MARK, this.state.metrics);
  };

  request = url => {
    if (this.props.request) {
      return this.props.request(url);
    }
    return fetch(url);
  };

  handleChangeQuery = value => {
    // Send text change to parent
    const { onQueryChange } = this.props;
    if (onQueryChange) {
      onQueryChange(value);
    }
  };

  handleTypeahead = (typeahead: TypeaheadInput): TypeaheadOutput => {
    const { editorNode, offset, selection, text, wrapperNode } = typeahead;

    const prefix = cleanText(text.substr(0, offset));

    // Determine candidates by context
    const suggestions: SuggestionGroup[] = [];
    const wrapperClasses = wrapperNode.classList;
    let context: string | null = null;
    let refresher: Promise<any>;

    // Take first metric as lucky guess
    const metricNode = editorNode.querySelector(`.${METRIC_MARK}`);

    if (wrapperClasses.contains('context-range')) {
      // Rate ranges
      context = 'context-range';
      suggestions.push({
        label: 'Range vector',
        items: [...RATE_RANGES].map(wrapText),
      });
    } else if (wrapperClasses.contains('context-labels') && metricNode) {
      const metric = metricNode.textContent;
      const labelKeys = this.state.labelKeys[metric];
      if (labelKeys) {
        if ((text && text.startsWith('=')) || wrapperClasses.contains('attr-value')) {
          // Label values
          const labelKeyNode = getPreviousCousin(wrapperNode, '.attr-name');
          if (labelKeyNode) {
            const labelKey = labelKeyNode.textContent;
            const labelValues = this.state.labelValues[metric][labelKey];
            context = 'context-label-values';
            suggestions.push({
              label: 'Label values',
              items: labelValues.map(wrapText),
            });
          }
        } else {
          // Label keys
          context = 'context-labels';
          suggestions.push({ label: 'Labels', items: labelKeys.map(wrapText) });
        }
      } else {
        refresher = this.fetchMetricLabels(metric);
      }
    } else if (wrapperClasses.contains('context-labels') && !metricNode) {
      // Empty name queries
      const defaultKeys = ['job', 'instance'];
      // Munge all keys that we have seen together
      const labelKeys = Object.keys(this.state.labelKeys).reduce((acc, metric) => {
        return acc.concat(this.state.labelKeys[metric].filter(key => acc.indexOf(key) === -1));
      }, defaultKeys);
      if ((text && text.startsWith('=')) || wrapperClasses.contains('attr-value')) {
        // Label values
        const labelKeyNode = getPreviousCousin(wrapperNode, '.attr-name');
        if (labelKeyNode) {
          const labelKey = labelKeyNode.textContent;
          if (this.state.labelValues[EMPTY_METRIC]) {
            const labelValues = this.state.labelValues[EMPTY_METRIC][labelKey];
            context = 'context-label-values';
            suggestions.push({
              label: 'Label values',
              items: labelValues.map(wrapText),
            });
          } else {
            // Can only query label values for now (API to query keys is under development)
            refresher = this.fetchLabelValues(labelKey);
          }
        }
      } else {
        // Label keys
        context = 'context-labels';
        suggestions.push({ label: 'Labels', items: labelKeys.map(wrapText) });
      }
    } else if (metricNode && wrapperClasses.contains('context-aggregation')) {
      context = 'context-aggregation';
      const metric = metricNode.textContent;
      const labelKeys = this.state.labelKeys[metric];
      if (labelKeys) {
        suggestions.push({ label: 'Labels', items: labelKeys.map(wrapText) });
      } else {
        refresher = this.fetchMetricLabels(metric);
      }
    } else if (
      (this.state.metrics && ((prefix && !wrapperClasses.contains('token')) || text.match(/[+\-*/^%]/))) ||
      wrapperClasses.contains('context-function')
    ) {
      // Need prefix for metrics
      context = 'context-metrics';
      suggestions.push({
        label: 'Metrics',
        items: this.state.metrics.map(wrapText),
      });
    }

    console.log('handleTypeahead', selection.anchorNode, wrapperClasses, text, offset, prefix, context);

    return {
      context,
      prefix,
      refresher,
      suggestions,
    };
  };

  async fetchLabelValues(key) {
    const url = `/api/v1/label/${key}/values`;
    try {
      const res = await this.request(url);
      const body = await (res.data || res.json());
      const pairs = this.state.labelValues[EMPTY_METRIC];
      const values = {
        ...pairs,
        [key]: body.data,
      };
      // const labelKeys = {
      //   ...this.state.labelKeys,
      //   [EMPTY_METRIC]: keys,
      // };
      const labelValues = {
        ...this.state.labelValues,
        [EMPTY_METRIC]: values,
      };
      this.setState({ labelValues });
    } catch (e) {
      if (this.props.onRequestError) {
        this.props.onRequestError(e);
      } else {
        console.error(e);
      }
    }
  }

  async fetchMetricLabels(name) {
    const url = `/api/v1/series?match[]=${name}`;
    try {
      const res = await this.request(url);
      const body = await (res.data || res.json());
      const { keys, values } = processLabels(body.data);
      const labelKeys = {
        ...this.state.labelKeys,
        [name]: keys,
      };
      const labelValues = {
        ...this.state.labelValues,
        [name]: values,
      };
      this.setState({ labelKeys, labelValues });
    } catch (e) {
      if (this.props.onRequestError) {
        this.props.onRequestError(e);
      } else {
        console.error(e);
      }
    }
  }

  async fetchMetricNames() {
    const url = '/api/v1/label/__name__/values';
    try {
      const res = await this.request(url);
      const body = await (res.data || res.json());
      this.setState({ metrics: body.data }, this.onMetricsReceived);
    } catch (error) {
      if (this.props.onRequestError) {
        this.props.onRequestError(error);
      } else {
        console.error(error);
      }
    }
  }

  render() {
    return (
      <TypeaheadField
        additionalPlugins={this.plugins}
        cleanText={cleanText}
        initialValue={this.props.initialQuery}
        onTypeahead={this.handleTypeahead}
        onWillApplySuggestion={willApplySuggestion}
        onValueChanged={this.handleChangeQuery}
        placeholder="Enter a PromQL query"
      />
    );
  }
}

export default PromQueryField;
