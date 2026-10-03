import { createContext, useContext } from 'react';
import translations from './zh-TW.json';
import type { Settings } from '../../shared/types';

export const LanguageContext = createContext<Settings['language']>('zh-TW');
export function translator(language: Settings['language']) {
  return (message: string, values: Record<string, string | number> = {}) => {
    const template =
      language === 'zh-TW'
        ? ((translations as Record<string, string>)[message] ?? message)
        : message;
    return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
  };
}
export function useI18n() {
  return translator(useContext(LanguageContext));
}
