/* eslint-disable no-useless-escape */
import moment from 'moment';
import _, { isEmpty } from 'lodash';
import axios from 'axios';
import JSON5 from 'json5';
import { executeAction } from '@/_helpers/appUtils';
import { toast } from 'react-hot-toast';
import { authenticationService } from '@/_services/authentication.service';
import { useSuperStore } from '../_stores/superStore';
import { getCurrentState } from '@/_stores/currentStateStore';
import { getWorkspaceIdOrSlugFromURL, getSubpath, returnWorkspaceIdIfNeed } from './routes';
import { getCookie, eraseCookie } from '@/_helpers/cookie';
import { staticDataSources } from '@/Editor/QueryManager/constants';
import { getDateTimeFormat } from '@/Editor/Components/Table/Datepicker';

export function findProp(obj, prop, defval) {
  if (typeof defval === 'undefined') defval = null;
  prop = prop.split('.');
  console.log('prop', prop);
  console.log('obj', obj);
  for (var i = 0; i < prop.length; i++) {
    if (prop[i].endsWith(']')) {
      const actual_prop = prop[i].split('[')[0];
      const index = prop[i].split('[')[1].split(']')[0];
      if (obj[actual_prop]) {
        obj = obj[actual_prop][index];
      } else {
        obj = undefined;
      }
    } else if (obj !== undefined) {
      if (typeof obj[prop[i]] === 'undefined') return defval;
      obj = obj[prop[i]];
    }
  }
  return obj;
}

export function stripTrailingSlash(str) {
  return str.replace(/[/]+$/, '');
}

export const pluralize = (count, noun, suffix = 's') => `${count} ${noun}${count !== 1 ? suffix : ''}`;

export function resolve(data, state) {
  if (data.startsWith('{{queries.') || data.startsWith('{{globals.') || data.startsWith('{{components.')) {
    let prop = data.replace('{{', '').replace('}}', '');
    return findProp(state, prop, '');
  }
}

function resolveCode(code, state, customObjects = {}, withError = false, reservedKeyword, isJsCode) {
  let result = '';
  let error;

  if (code === '_' || code.includes('this._')) {
    error = `Cannot resolve circular reference ${code}`;
  } else if (code.startsWith('queries.') && code.endsWith('run()')) {
    //! dont resolve if code starts with "queries." and ends with "run()"
    error = `Cannot resolve function call ${code}`;
  } else {
    try {
      const evalFunction = Function(
        [
          'variables',
          'components',
          'queries',
          'globals',
          'page',
          'client',
          'server',
          'constants',
          'parameters',
          'moment',
          '_',
          ...Object.keys(customObjects),
          reservedKeyword,
        ],
        `return ${code}`
      );
      result = evalFunction(
        isJsCode ? state?.variables : undefined,
        isJsCode ? state?.components : undefined,
        isJsCode ? state?.queries : undefined,
        isJsCode ? state?.globals : undefined,
        isJsCode ? state?.page : undefined,
        isJsCode ? undefined : state?.client,
        isJsCode ? undefined : state?.server,
        state?.constants, // Passing constants as an argument allows the evaluated code to access and utilize the constants value correctly.
        state?.parameters,
        moment,
        _,
        ...Object.values(customObjects),
        null
      );
    } catch (err) {
      error = err;
      // console.log('eval_error', err);
    }
  }

  if (withError) return [result, error];
  return result;
}
export function resolveString(str, state, customObjects, reservedKeyword, withError, forPreviewBox) {
  let resolvedStr = str;

  // Resolve {{object}}
  const codeRegex = /(\{\{.+?\}\})/g;
  const codeMatches = resolvedStr.match(codeRegex);

  if (codeMatches) {
    codeMatches.forEach((codeMatch) => {
      const code = codeMatch.replace('{{', '').replace('}}', '');

      if (reservedKeyword.includes(code)) {
        resolvedStr = resolvedStr.replace(codeMatch, '');
      } else {
        const resolvedCode = resolveCode(code, state, customObjects, withError, reservedKeyword, true);
        if (forPreviewBox) {
          resolvedStr = resolvedStr.replace(codeMatch, resolvedCode[0]);
        } else {
          resolvedStr = resolvedStr.replace(codeMatch, resolvedCode);
        }
      }
    });
  }

  // Resolve %%object%%
  const serverRegex = /(%%.+?%%)/g;
  const serverMatches = resolvedStr.match(serverRegex);

  if (serverMatches) {
    serverMatches.forEach((serverMatch) => {
      const code = serverMatch.replace(/%%/g, '');

      if (code.includes('server.') && !/^server\.[A-Za-z0-9]+$/.test(code)) {
        resolvedStr = resolvedStr.replace(serverMatch, 'HiddenEnvironmentVariable');
      } else {
        const resolvedCode = resolveCode(code, state, customObjects, withError, reservedKeyword, false);
        if (forPreviewBox) {
          resolvedStr = resolvedStr.replace(serverMatch, resolvedCode[0]);
        } else {
          resolvedStr = resolvedStr.replace(serverMatch, resolvedCode);
        }
      }
    });
  }

  return resolvedStr;
}

export function resolveReferences(
  object,
  state,
  defaultValue,
  customObjects = {},
  withError = false,
  forPreviewBox = false
) {
  if (object === '{{{}}}') return '';
  const reservedKeyword = ['app', 'window']; //Keywords that slows down the app
  object = _.clone(object);
  const objectType = typeof object;
  let error;
  switch (objectType) {
    case 'string': {
      if (object.includes('{{') && object.includes('}}') && object.includes('%%') && object.includes('%%')) {
        object = resolveString(object, state, customObjects, reservedKeyword, withError, forPreviewBox);
      }

      if (object.startsWith('{{') && object.endsWith('}}')) {
        if ((object.match(/{{/g) || []).length === 1) {
          const code = object.replace('{{', '').replace('}}', '');

          if (reservedKeyword.includes(code)) {
            error = `${code} is a reserved keyword`;
            return [{}, error];
          }

          return resolveCode(code, state, customObjects, withError, reservedKeyword, true);
        } else {
          const dynamicVariables = getDynamicVariables(object);

          for (const dynamicVariable of dynamicVariables) {
            const value = resolveString(
              dynamicVariable,
              state,
              customObjects,
              reservedKeyword,
              withError,
              forPreviewBox
            );

            if (typeof value !== 'function') {
              object = object.replace(dynamicVariable, value);
            }
          }
        }
      } else if (object.startsWith('%%') && object.endsWith('%%')) {
        const code = object.replaceAll('%%', '');

        if (code.includes('server.') && !new RegExp('^server.[A-Za-z0-9]+$').test(code)) {
          error = `${code} is invalid. Server variables can't be used like this`;
          return [{}, error];
        }

        return resolveCode(code, state, customObjects, withError, reservedKeyword, false);
      }

      const dynamicVariables = getDynamicVariables(object);

      if (dynamicVariables) {
        if (dynamicVariables.length === 1 && dynamicVariables[0] === object) {
          object = resolveReferences(dynamicVariables[0], state, null, customObjects);
        } else {
          for (const dynamicVariable of dynamicVariables) {
            const value = resolveReferences(dynamicVariable, state, null, customObjects);
            if (typeof value !== 'function') {
              object = object.replace(dynamicVariable, value);
            }
          }
        }
      }
      if (withError) return [object, error];
      return object;
    }

    case 'object': {
      if (Array.isArray(object)) {
        const new_array = [];

        object.forEach((element, index) => {
          const resolved_object = resolveReferences(element, state);
          new_array[index] = resolved_object;
        });

        if (withError) return [new_array, error];
        return new_array;
      } else if (!_.isEmpty(object)) {
        Object.keys(object).forEach((key) => {
          const resolved_object = resolveReferences(object[key], state);
          object[key] = resolved_object;
        });
        if (withError) return [object, error];
        return object;
      }
    }
    // eslint-disable-next-line no-fallthrough
    default: {
      if (withError) return [object, error];
      return object;
    }
  }
}

export function getDynamicVariables(text) {
  const matchedParams = text.match(/\{\{(.*?)\}\}/g) || text.match(/\%\%(.*?)\%\%/g);
  return matchedParams;
}

export function computeComponentName(componentType, currentComponents) {
  const currentComponentsForKind = Object.values(currentComponents).filter(
    (component) => component.component.component === componentType
  );
  let found = false;
  let componentName = '';
  let currentNumber = currentComponentsForKind.length + 1;

  while (!found) {
    componentName = `${componentType.toLowerCase()}${currentNumber}`;
    if (
      Object.values(currentComponents).find((component) => component.component.name === componentName) === undefined
    ) {
      found = true;
    }
    currentNumber = currentNumber + 1;
  }

  return componentName;
}

export function computeActionName(actions) {
  const values = actions ? actions.value : [];

  let currentNumber = values.length;
  let found = false;
  let actionName = '';

  while (!found) {
    actionName = `Action${currentNumber}`;
    if (values.find((action) => action.name === actionName) === undefined) {
      found = true;
    }
    currentNumber += 1;
  }

  return actionName;
}

export function validateQueryName(name) {
  const nameRegex = new RegExp('^[A-Za-z0-9_-]*$');
  return nameRegex.test(name);
}

export const convertToKebabCase = (string) =>
  string
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();

export const serializeNestedObjectToQueryParams = function (obj, prefix) {
  var str = [],
    p;
  for (p in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, p)) {
      var k = prefix ? prefix + '[' + p + ']' : p,
        v = obj[p];
      str.push(
        // eslint-disable-next-line no-undef
        v !== null && typeof v === 'object' ? serialize(v, k) : encodeURIComponent(k) + '=' + encodeURIComponent(v)
      );
    }
  }
  return str.join('&');
};

export function resolveWidgetFieldValue(prop, state, _default = [], customResolveObjects = {}) {
  const widgetFieldValue = prop;

  try {
    return resolveReferences(widgetFieldValue, state, _default, customResolveObjects);
  } catch (err) {
    console.log(err);
  }

  return widgetFieldValue;
}

export function validateWidget({ validationObject, widgetValue, currentState, customResolveObjects }) {
  let isValid = true;
  let validationError = null;

  const regex = validationObject?.regex?.value;
  const minLength = validationObject?.minLength?.value;
  const maxLength = validationObject?.maxLength?.value;
  const minValue = validationObject?.minValue?.value;
  const maxValue = validationObject?.maxValue?.value;
  const customRule = validationObject?.customRule?.value;
  const mandatory = validationObject?.mandatory?.value;
  const validationRegex = resolveWidgetFieldValue(regex, currentState, '', customResolveObjects);
  const re = new RegExp(validationRegex, 'g');

  if (!re.test(widgetValue)) {
    return {
      isValid: false,
      validationError: 'The input should match pattern',
    };
  }

  const resolvedMinLength = resolveWidgetFieldValue(minLength, currentState, 0, customResolveObjects);
  if ((widgetValue || '').length < parseInt(resolvedMinLength)) {
    return {
      isValid: false,
      validationError: `Minimum ${resolvedMinLength} characters is needed`,
    };
  }

  const resolvedMaxLength = resolveWidgetFieldValue(maxLength, currentState, undefined, customResolveObjects);
  if (resolvedMaxLength !== undefined) {
    if ((widgetValue || '').length > parseInt(resolvedMaxLength)) {
      return {
        isValid: false,
        validationError: `Maximum ${resolvedMaxLength} characters is allowed`,
      };
    }
  }

  const resolvedMinValue = resolveWidgetFieldValue(minValue, currentState, undefined, customResolveObjects);
  if (resolvedMinValue !== undefined) {
    if (widgetValue === undefined || widgetValue < parseFloat(resolvedMinValue)) {
      return {
        isValid: false,
        validationError: `Minimum value is ${resolvedMinValue}`,
      };
    }
  }

  const resolvedMaxValue = resolveWidgetFieldValue(maxValue, currentState, undefined, customResolveObjects);
  if (resolvedMaxValue !== undefined) {
    if (widgetValue === undefined || widgetValue > parseFloat(resolvedMaxValue)) {
      return {
        isValid: false,
        validationError: `Maximum value is ${resolvedMaxValue}`,
      };
    }
  }

  const resolvedCustomRule = resolveWidgetFieldValue(customRule, currentState, false, customResolveObjects);
  if (typeof resolvedCustomRule === 'string' && resolvedCustomRule !== '') {
    return { isValid: false, validationError: resolvedCustomRule };
  }

  const resolvedMandatory = resolveWidgetFieldValue(mandatory, currentState, false, customResolveObjects);

  if (resolvedMandatory == true) {
    if (!widgetValue) {
      return { isValid: false, validationError: `Field cannot be empty` };
    }
  }
  return {
    isValid,
    validationError,
  };
}

export function validateDates({ validationObject, widgetValue, currentState, customResolveObjects }) {
  let isValid = true;
  let validationError = null;
  const validationDateFormat = validationObject?.dateFormat?.value || 'MM/DD/YYYY';
  const validationTimeFormat = validationObject?.timeFormat?.value || 'HH:mm';
  const customRule = validationObject?.customRule?.value;
  const parsedDateFormat = validationObject?.parseDateFormat?.value;
  const isTwentyFourHrFormatEnabled = validationObject?.isTwentyFourHrFormatEnabled?.value ?? false;
  const isDateSelectionEnabled = validationObject?.isDateSelectionEnabled?.value ?? true;
  const _widgetDateValue = moment(widgetValue, parsedDateFormat);
  const _widgetTimeValue = moment(
    widgetValue,
    getDateTimeFormat(parsedDateFormat, true, isTwentyFourHrFormatEnabled, isDateSelectionEnabled)
  ).format(validationTimeFormat);

  const resolvedMinDate = resolveWidgetFieldValue(
    validationObject?.minDate?.value,
    currentState,
    undefined,
    customResolveObjects
  );
  const resolvedMaxDate = resolveWidgetFieldValue(
    validationObject?.maxDate?.value,
    currentState,
    undefined,
    customResolveObjects
  );
  const resolvedMinTime = resolveWidgetFieldValue(
    validationObject?.minTime?.value,
    currentState,
    undefined,
    customResolveObjects
  );
  const resolvedMaxTime = resolveWidgetFieldValue(
    validationObject?.maxTime?.value,
    currentState,
    undefined,
    customResolveObjects
  );

  // Minimum date validation
  if (resolvedMinDate !== undefined && moment(resolvedMinDate).isValid()) {
    if (!moment(resolvedMinDate, validationDateFormat).isBefore(moment(_widgetDateValue, validationDateFormat))) {
      return {
        isValid: false,
        validationError: `Minimum date is ${resolvedMinDate}`,
      };
    }
  }

  // Maximum date validation
  if (resolvedMaxDate !== undefined && moment(resolvedMaxDate).isValid()) {
    if (!moment(resolvedMaxDate, validationDateFormat).isAfter(moment(_widgetDateValue, validationDateFormat))) {
      return {
        isValid: false,
        validationError: `Maximum date is ${resolvedMaxDate}`,
      };
    }
  }

  // Minimum time validation
  if (resolvedMinTime !== undefined && moment(resolvedMinTime, validationTimeFormat, true).isValid()) {
    if (!moment(resolvedMinTime, validationTimeFormat).isBefore(moment(_widgetTimeValue, validationTimeFormat))) {
      return {
        isValid: false,
        validationError: `Minimum time is ${resolvedMinTime}`,
      };
    }
  }

  // Maximum time validation
  if (resolvedMaxTime !== undefined && moment(resolvedMaxTime, validationTimeFormat, true).isValid()) {
    if (!moment(resolvedMaxTime, validationTimeFormat).isAfter(moment(_widgetTimeValue, validationTimeFormat))) {
      return {
        isValid: false,
        validationError: `Maximum time is ${resolvedMaxTime}`,
      };
    }
  }

  //Custom rule validation
  const resolvedCustomRule = resolveWidgetFieldValue(customRule, currentState, false, customResolveObjects);
  if (typeof resolvedCustomRule === 'string' && resolvedCustomRule !== '') {
    return { isValid: false, validationError: resolvedCustomRule };
  }
  return {
    isValid,
    validationError,
  };
}

export function validateEmail(email) {
  const emailRegex =
    /^(([^<>()[\]\.,;:\s@\"]+(\.[^<>()[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
  return emailRegex.test(email);
}

// eslint-disable-next-line no-unused-vars
export async function executeMultilineJS(
  _ref,
  code,
  queryId,
  isPreview,
  mode = '',
  parameters = {},
  hasParamSupport = false
) {
  const currentState = getCurrentState(_ref.moduleName);
  let result = {},
    error = null;

  //if user passes anything other than object, params are reset to empty
  if (typeof parameters !== 'object' || parameters === null) {
    parameters = {};
  }

  const actions = generateAppActions(_ref, queryId, mode, isPreview);

  const queryDetails = useSuperStore
    .getState()
    .modules[_ref.moduleName].useDataQueriesStore.getState()
    .dataQueries.find((q) => q.id === queryId);

  const defaultParams =
    queryDetails?.options?.parameters?.reduce(
      (paramObj, param) => ({
        ...paramObj,
        [param.name]: resolveReferences(param.defaultValue, {}, undefined), //default values will not be resolved with currentState
      }),
      {}
    ) || {};

  let formattedParams = {};
  if (queryDetails) {
    Object.keys(defaultParams).map((key) => {
      /** The value of param is replaced with defaultValue if its passed undefined */
      formattedParams[key] = parameters[key] === undefined ? defaultParams[key] : parameters[key];
    });
  } else {
    //this will handle the preview case where you cannot find the queryDetails in state.
    formattedParams = { ...parameters };
  }

  for (const key of Object.keys(currentState.queries)) {
    currentState.queries[key] = {
      ...currentState.queries[key],
      run: (params) => {
        if (typeof params !== 'object' || params === null) {
          params = {};
        }
        const processedParams = {};
        const query = useSuperStore
          .getState()
          .modules.modules[_ref.moduleName].useDataQueriesStore.getState()
          .dataQueries.find((q) => q.name === key);
        query.options.parameters?.forEach((arg) => (processedParams[arg.name] = params[arg.name]));
        return actions.runQuery(key, processedParams);
      },

      getData: () => {
        return getCurrentState().queries[key].data;
      },

      getRawData: () => {
        return getCurrentState().queries[key].rawData;
      },

      getloadingState: () => {
        return getCurrentState().queries[key].isLoading;
      },
    };
  }

  try {
    const AsyncFunction = new Function(`return Object.getPrototypeOf(async function(){}).constructor`)();
    const fnParams = [
      'moment',
      '_',
      'components',
      'queries',
      'globals',
      'page',
      'axios',
      'variables',
      'actions',
      'client',
      'server',
      'constants',
      ...(!_.isEmpty(formattedParams) ? ['parameters'] : []), // Parameters are supported if builder has added atleast one parameter to the query
      code,
    ];
    var evalFn = new AsyncFunction(...fnParams);

    const fnArgs = [
      moment,
      _,
      currentState.components,
      currentState.queries,
      currentState.globals,
      currentState.page,
      axios,
      currentState.variables,
      actions,
      currentState?.client,
      currentState?.server,
      currentState?.constants,
      ...(!_.isEmpty(formattedParams) ? [formattedParams] : []), // Parameters are supported if builder has added atleast one parameter to the query
    ];
    result = {
      status: 'ok',
      data: await evalFn(...fnArgs),
    };
  } catch (err) {
    console.log('JS execution failed: ', err);
    error = err.stack.split('\n')[0];
    result = { status: 'failed', data: { message: error, description: error } };
  }

  return result;
}

export function toQuery(params, delimiter = '&') {
  const keys = Object.keys(params);

  return keys.reduce((str, key, index) => {
    let query = `${str}${key}=${params[key]}`;

    if (index < keys.length - 1) {
      query += delimiter;
    }

    return query;
  }, '');
}

export const isJson = (str) => {
  try {
    JSON5.parse(str);
  } catch (e) {
    return false;
  }
  return true;
};

export function buildURLWithQuery(url, query = {}) {
  return `${url}?${toQuery(query)}`;
}

export const handleCircularStructureToJSON = () => {
  const seen = new WeakSet();

  return (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return 'Object';
      }
      seen.add(value);
    }
    return value;
  };
};

export function hasCircularDependency(obj) {
  try {
    JSON.stringify(obj);
  } catch (e) {
    return String(e).includes('Converting circular structure to JSON');
  }
  return false;
}

export const hightlightMentionedUserInComment = (comment) => {
  var regex = /(\()([^)]+)(\))/g;
  return comment.replace(regex, '<span class=mentioned-user>$2</span>');
};

export const generateAppActions = (_ref, queryId, mode, isPreview = false) => {
  const currentPageId = _ref.currentPageId;
  const currentComponents = _ref.appDefinition?.pages[currentPageId]?.components
    ? Object.entries(_ref.appDefinition.pages[currentPageId]?.components)
    : {};

  const runQuery = (queryName = '', parameters) => {
    const query = useSuperStore
      .getState()
      .modules[_ref.moduleName].useDataQueriesStore.getState()
      .dataQueries.find((query) => {
        const isFound = query.name === queryName;
        if (isPreview) {
          return isFound;
        } else {
          return isFound && isQueryRunnable(query);
        }
      });

    const processedParams = {};
    if (_.isEmpty(query) || queryId === query?.id) {
      const errorMsg = queryId === query?.id ? 'Cannot run query from itself' : 'Query not found';
      toast.error(errorMsg);
      return;
    }

    if (!_.isEmpty(query?.options?.parameters)) {
      query.options.parameters?.forEach(
        (param) => parameters && (processedParams[param.name] = parameters?.[param.name])
      );
    }

    // if (isPreview) {
    //   return previewQuery(_ref, query, true, processedParams);
    // }

    const event = {
      actionId: 'run-query',
      queryId: query.id,
      queryName: query.name,
      parameters: processedParams,
    };

    return executeAction(_ref, event, mode, {});
  };

  const setVariable = (key = '', value = '') => {
    if (key) {
      const event = {
        actionId: 'set-custom-variable',
        key,
        value,
      };
      return executeAction(_ref, event, mode, {});
    }
  };

  const getVariable = (key = '') => {
    if (key) {
      const event = {
        actionId: 'get-custom-variable',
        key,
      };
      return executeAction(_ref, event, mode, {});
    }
  };

  const unSetVariable = (key = '') => {
    if (key) {
      const event = {
        actionId: 'unset-custom-variable',
        key,
      };
      return executeAction(_ref, event, mode, {});
    }
  };

  const showAlert = (alertType = '', message = '') => {
    const event = {
      actionId: 'show-alert',
      alertType,
      message,
    };
    return executeAction(_ref, event, mode, {});
  };

  const logout = () => {
    const event = {
      actionId: 'logout',
    };
    return executeAction(_ref, event, mode, {});
  };

  const showModal = (modalName = '') => {
    let modal = '';
    for (const [key, value] of currentComponents) {
      if (value.component.name === modalName) {
        modal = key;
      }
    }

    const event = {
      actionId: 'show-modal',
      modal,
    };
    return executeAction(_ref, event, mode, {});
  };

  const closeModal = (modalName = '') => {
    let modal = '';
    for (const [key, value] of currentComponents) {
      if (value.component.name === modalName) {
        modal = key;
      }
    }

    const event = {
      actionId: 'close-modal',
      modal,
    };
    return executeAction(_ref, event, mode, {});
  };

  const setLocalStorage = (key = '', value = '') => {
    const event = {
      actionId: 'set-localstorage-value',
      key,
      value,
    };
    return executeAction(_ref, event, mode, {});
  };

  const copyToClipboard = (contentToCopy = '') => {
    const event = {
      actionId: 'copy-to-clipboard',
      contentToCopy,
    };
    return executeAction(_ref, event, mode, {});
  };

  const goToApp = (slug = '', queryParams = []) => {
    const event = {
      actionId: 'go-to-app',
      slug,
      queryParams,
    };
    return executeAction(_ref, event, mode, {});
  };

  const generateFile = (fileName, fileType, data) => {
    if (!fileName || !fileType || !data) {
      return toast.error('Action failed: fileName, fileType and data are required');
    }

    const event = {
      actionId: 'generate-file',
      fileName,
      data,
      fileType,
    };
    return executeAction(_ref, event, mode, {});
  };

  const setPageVariable = (key = '', value = '') => {
    const event = {
      actionId: 'set-page-variable',
      key,
      value,
    };
    return executeAction(_ref, event, mode, {});
  };

  const getPageVariable = (key = '') => {
    const event = {
      actionId: 'get-page-variable',
      key,
    };
    return executeAction(_ref, event, mode, {});
  };

  const unsetPageVariable = (key = '') => {
    const event = {
      actionId: 'unset-page-variable',
      key,
    };
    return executeAction(_ref, event, mode, {});
  };

  const switchPage = (pageHandle, queryParams = []) => {
    if (isPreview) {
      mode != 'view' &&
        toast('Page will not be switched for query preview', {
          icon: '⚠️',
        });
      return Promise.resolve();
    }
    const pages = _ref.appDefinition.pages;
    const pageId = Object.keys(pages).find((key) => pages[key].handle === pageHandle);

    if (!pageId) {
      mode === 'edit' &&
        toast('Valid page handle is required', {
          icon: '⚠️',
        });
      return Promise.resolve();
    }

    const event = {
      actionId: 'switch-page',
      pageId,
      queryParams,
    };
    return executeAction(_ref, event, mode, {});
  };

  return {
    runQuery,
    setVariable,
    getVariable,
    unSetVariable,
    showAlert,
    logout,
    showModal,
    closeModal,
    setLocalStorage,
    copyToClipboard,
    goToApp,
    generateFile,
    setPageVariable,
    getPageVariable,
    unsetPageVariable,
    switchPage,
  };
};

export const loadPyodide = async () => {
  try {
    const pyodide = await window.loadPyodide({ indexURL: '/assets/libs/pyodide-0.23.2/' });
    return pyodide;
  } catch (error) {
    console.log('loadPyodide error', error);
    throw 'Could not load Pyodide to execute Python';
  }
};
export function safelyParseJSON(json) {
  try {
    return JSON.parse(json);
  } catch (e) {
    console.log('JSON parse error');
  }
  return;
}

export const getuserName = (formData) => {
  let nameArray = formData?.name?.trim().split(' ');
  if (nameArray?.length > 0)
    return `${nameArray?.[0][0]}${nameArray?.[1] != undefined && nameArray?.[1] != '' ? nameArray?.[1][0] : ''} `;
  return '';
};

export const removeSpaceFromWorkspace = (name) => {
  return name?.replace(' ', '-') || '';
};

export const getWorkspaceId = () =>
  getWorkspaceIdOrSlugFromURL() ||
  authenticationService.currentSessionValue?.current_organization_slug ||
  authenticationService.currentSessionValue?.current_organization_id;

export const handleUnSubscription = (subsciption) => {
  setTimeout(() => {
    subsciption.unsubscribe();
  }, 5000);
};

export const getAvatar = (organization) => {
  if (!organization) return;

  const orgName = organization.split(' ').filter((e) => e && !!e.trim());
  if (orgName.length > 1) {
    return `${orgName[0]?.[0]}${orgName[1]?.[0]}`;
  } else if (organization.length >= 2) {
    return `${organization[0]}${organization[1]}`;
  } else {
    return `${organization[0]}${organization[0]}`;
  }
};

export function isExpectedDataType(data, expectedDataType) {
  function getCurrentDataType(node) {
    return Object.prototype.toString.call(node).slice(8, -1).toLowerCase();
  }

  const currentDataType = getCurrentDataType(data);

  if (currentDataType !== expectedDataType) {
    switch (expectedDataType) {
      case 'string':
        return String(data) ? data : undefined;
      case 'number':
        return Object.prototype.toString.call(data).slice(8, -1).toLowerCase() === 'number' ? data : undefined;
      case 'boolean':
        return Boolean();
      case 'array':
        return Object.prototype.toString.call(data).slice(8, -1).toLowerCase() === 'array' ? data : [];
      case 'object':
        return Object.prototype.toString.call(data).slice(8, -1).toLowerCase() === 'object' ? data : {};
      default:
        return null;
    }
  }

  return data;
}

export const validateName = (
  name,
  nameType,
  emptyCheck = true,
  showError = false,
  allowSpecialChars = true,
  allowSpaces = true,
  checkReservedWords = false,
  allowAllCases = false
) => {
  const newName = name;
  let errorMsg = '';
  if (emptyCheck && !newName) {
    errorMsg = `${nameType} can't be empty`;
    showError &&
      toast.error(errorMsg, {
        id: '1',
      });
    return {
      status: false,
      errorMsg,
    };
  }

  if (newName) {
    //check for alphanumeric
    const regex = allowAllCases ? /^[a-zA-Z0-9 -]+$/ : /^[a-z0-9 -]+$/;
    if (!allowSpecialChars && newName.match(regex) === null) {
      if (/[A-Z]/.test(newName) && !allowAllCases) {
        errorMsg = 'Only lowercase letters are accepted.';
      } else {
        errorMsg = `Special characters are not accepted.`;
      }
      showError &&
        toast.error(errorMsg, {
          id: '2',
        });
      return {
        status: false,
        errorMsg,
      };
    }

    if (!allowSpaces && /\s/g.test(newName)) {
      errorMsg = 'Cannot contain spaces';
      showError &&
        toast.error(errorMsg, {
          id: '3',
        });
      return {
        status: false,
        errorMsg,
      };
    }

    if (newName.length > 50) {
      errorMsg = `Maximum length has been reached.`;
      showError &&
        toast.error(errorMsg, {
          id: '3',
        });
      return {
        status: false,
        errorMsg,
      };
    }

    /* Add more reserved paths here, which doesn't have /:workspace-id prefix */
    const reservedPaths = [
      'forgot-password',
      'switch-workspace',
      'reset-password',
      'invitations',
      'organization-invitations',
      'sso',
      'setup',
      'confirm',
      ':workspaceId',
      'confirm-invite',
      'oauth2',
      'applications',
      'integrations',
      'login',
      'signup',
    ];

    if (checkReservedWords && reservedPaths.includes(newName)) {
      errorMsg = `Reserved words are not allowed.`;
      showError &&
        toast.error(errorMsg, {
          id: '3',
        });
      return {
        status: false,
        errorMsg,
      };
    }
  }

  return {
    status: true,
    errorMsg: '',
  };
};

export const handleHttpErrorMessages = ({ statusCode, error }, feature_name) => {
  switch (statusCode) {
    case 500: {
      toast.error(
        `Something went wrong on our end and this ${feature_name} could not be created. Please try \n again or contact our support team if the \n problem persists.`
      );
      break;
    }
    case 503: {
      toast.error(
        `We weren't able to connect to our servers to complete this request. Please check your \n internet connection and try again.`
      );
      break;
    }
    default: {
      toast.error(error ? error : 'Something went wrong. please try again.', {
        position: 'top-center',
      });
      break;
    }
  }
};

export const defaultAppEnvironments = [{ name: 'production', isDefault: true, priority: 3 }];

export const deepEqual = (obj1, obj2, excludedKeys = []) => {
  if (obj1 === obj2) {
    return true;
  }

  if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 === null || obj2 === null) {
    return false;
  }

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  const uniqueKeys = [...new Set([...keys1, ...keys2])];

  for (let key of uniqueKeys) {
    if (!excludedKeys.includes(key)) {
      if (!(key in obj1) || !(key in obj2)) {
        return false;
      }

      if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
        if (!deepEqual(obj1[key], obj2[key], excludedKeys)) {
          return false;
        }
      } else if (obj1[key] != obj2[key]) {
        return false;
      }
    }
  }

  return true;
};

export function eraseRedirectUrl() {
  const redirectPath = getCookie('redirectPath');
  redirectPath && eraseCookie('redirectPath');
  return redirectPath;
}

export const redirectToWorkspace = () => {
  const path = eraseRedirectUrl();
  const redirectPath = `${returnWorkspaceIdIfNeed(path)}${path && path !== '/' ? path : ''}`;
  window.location = getSubpath() ? `${getSubpath()}${redirectPath}` : redirectPath;
};

/** Check if the query is connected to a DS. */
export const isQueryRunnable = (query) => {
  if (staticDataSources.find((source) => query.kind === source.kind)) {
    return true;
  }
  //TODO: both view api and creat/update apis return dataSourceId in two format 1) camelCase 2) snakeCase. Need to unify it.
  return !!(query?.data_source_id || query?.dataSourceId || !isEmpty(query?.plugins));
};

export const redirectToDashboard = () => {
  const subpath = getSubpath();
  window.location = `${subpath ? `${subpath}` : ''}/${getWorkspaceId()}`;
};

export const determineJustifyContentValue = (value) => {
  switch (value) {
    case 'left':
      return 'start';
    case 'right':
      return 'end';
    case 'center':
      return 'center';
    default:
      return 'start';
  }
};

export const USER_DRAWER_MODES = {
  EDIT: 'EDIT',
  CREATE: 'CREATE',
};

export const humanizeifDefaultGroupName = (groupName) => {
  switch (groupName) {
    case 'all_users':
      return 'All users';

    case 'admin':
      return 'Admin';

    default:
      return groupName;
  }
};

export const defaultWhiteLabellingSettings = {
  WHITE_LABEL_LOGO: 'https://app.tooljet.com/logo.svg',
  WHITE_LABEL_TEXT: 'ToolJet',
  WHITE_LABEL_FAVICON: 'https://app.tooljet.com/favico.png',
};

export const pageTitles = {
  INSTANCE_SETTINGS: 'Settings',
  WORKSPACE_SETTINGS: 'Workspace settings',
  INTEGRATIONS: 'Marketplace',
  WORKFLOWS: 'Workflows',
  DATABASE: 'Database',
  DATA_SOURCES: 'Data sources',
  AUDIT_LOGS: 'Audit logs',
  ACCOUNT_SETTINGS: 'Profile settings',
  SETTINGS: 'Profile settings',
  EDITOR: 'Editor',
  WORKFLOW_EDITOR: 'workflowEditor',
  VIEWER: 'Viewer',
  DASHBOARD: 'Dashboard',
  WORKSPACE_CONSTANTS: 'Workspace constants',
};

export const setWindowTitle = async (pageDetails, location) => {
  const isEditorOrViewerGoingToRender = ['/apps/', '/applications/'].some((path) => location?.pathname.includes(path));
  const pathToTitle = {
    'instance-settings': pageTitles.INSTANCE_SETTINGS,
    'workspace-settings': pageTitles.WORKSPACE_SETTINGS,
    integrations: pageTitles.INTEGRATIONS,
    workflows: pageTitles.WORKFLOWS,
    database: pageTitles.DATABASE,
    'data-sources': pageTitles.DATA_SOURCES,
    'audit-logs': pageTitles.AUDIT_LOGS,
    'account-settings': pageTitles.ACCOUNT_SETTINGS,
    settings: pageTitles.SETTINGS,
    'workspace-constants': pageTitles.WORKSPACE_CONSTANTS,
  };
  const whiteLabelText = defaultWhiteLabellingSettings.WHITE_LABEL_TEXT;
  let pageTitleKey = pageDetails?.page || '';
  let pageTitle = '';
  if (!pageTitleKey && !isEditorOrViewerGoingToRender) {
    pageTitleKey = Object.keys(pathToTitle).find((path) => location?.pathname?.includes(path)) || '';
  }
  switch (pageTitleKey) {
    case pageTitles.VIEWER: {
      const titlePrefix = pageDetails?.preview ? 'Preview - ' : '';
      pageTitle = `${titlePrefix}${pageDetails?.appName || 'My App'}`;
      break;
    }
    case pageTitles.EDITOR:
    case pageTitles.WORKFLOW_EDITOR: {
      pageTitle = pageDetails?.appName || 'My App';
      break;
    }
    default: {
      pageTitle = pathToTitle[pageTitleKey] || pageTitleKey;
      break;
    }
  }
  if (pageTitle) {
    document.title = !(pageDetails?.preview === false) ? `${pageTitle} | ${whiteLabelText}` : `${pageTitle}`;
  }
};
