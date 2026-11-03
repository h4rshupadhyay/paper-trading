import {createContext,useContext,useState,useEffect,useCallback} from 'react'
import {currencyAPI} from '../services/api'
import {currencyForSymbol,convertDisplayCurrency} from '../services/contracts'
export const tickerCurrency=currencyForSymbol
export const REGIONS = [
  {
    id:           'US',
    label:        'United States',
    flag:         '🇺🇸',
    currency:     'USD',
    symbol:       '$',
    index:        '^GSPC',
    indexName:    'S&P 500',
    tickerSuffix: [],          // no suffix = US
    stockCurrency: 'USD',     // native price currency for region stocks
  },
  {
    id:           'IN',
    label:        'India',
    flag:         '🇮🇳',
    currency:     'INR',
    symbol:       '₹',
    index:        '^NSEI',
    indexName:    'NIFTY 50',
    tickerSuffix: ['.NS', '.BO'],
    stockCurrency: 'INR',
  },
  {
    id:           'UK',
    label:        'United Kingdom',
    flag:         '🇬🇧',
    currency:     'GBP',
    symbol:       '£',
    index:        '^FTSE',
    indexName:    'FTSE 100',
    tickerSuffix: ['.L'],
    stockCurrency: 'GBP',
  },
  {
    id:           'EU',
    label:        'Europe',
    flag:         '🇪🇺',
    currency:     'EUR',
    symbol:       '€',
    index:        '^GDAXI',
    indexName:    'DAX',
    tickerSuffix: ['.DE', '.PA', '.F'],
    stockCurrency: 'EUR',
  },
  {
    id:           'JP',
    label:        'Japan',
    flag:         '🇯🇵',
    currency:     'JPY',
    symbol:       '¥',
    index:        '^N225',
    indexName:    'Nikkei 225',
    tickerSuffix: ['.T'],
    stockCurrency: 'JPY',
  },
  {
    id:           'HK',
    label:        'Hong Kong',
    flag:         '🇭🇰',
    currency:     'HKD',
    symbol:       'HK$',
    index:        '^HSI',
    indexName:    'Hang Seng',
    tickerSuffix: ['.HK'],
    stockCurrency: 'HKD',
  },
]


const RegionContext=createContext(null)
export function RegionProvider({children}) {
  const [regionId,setRegionId]=useState(()=>localStorage.getItem('region')||'IN')
  const [rates,setRates]=useState({}),[ratesLoaded,setRatesLoaded]=useState(false)
  const [fxAsOf,setFxAsOf]=useState(Date.now)
  const region=REGIONS.find(value=>value.id===regionId)||REGIONS[1]
  useEffect(()=>localStorage.setItem('region',regionId),[regionId])
  useEffect(()=>{
    const load=()=>currencyAPI.rates().then(({data})=>{
      const next={}
      for(const item of data.items??[])next[item.currency]=item
      setRates(next);setFxAsOf(Date.now());setRatesLoaded(true)
    }).catch(()=>setRatesLoaded(true))
    load();window.addEventListener('paper:authenticated',load)
    const timer=setInterval(()=>{setFxAsOf(Date.now());load()},60000)
    return()=>{clearInterval(timer);window.removeEventListener('paper:authenticated',load)}
  },[])
  const convert=useCallback((value,source,target=region.currency)=>{
    return convertDisplayCurrency(value,source,target,rates)
  },[rates,region.currency,fxAsOf])
  const format=useCallback((value,source,opts={})=>{
    const number=convert(value,source)
    if(number==null)return `${region.symbol}—`
    return `${region.symbol}${number.toLocaleString('en-IN',{minimumFractionDigits:opts.decimals??2,maximumFractionDigits:opts.decimals??2,...(opts.compact?{notation:'compact'}:{})})}`
  },[convert,region.symbol])
  const formatCurrency=useCallback((value,opts={})=>format(value,'INR',opts),[format])
  const formatPrice=useCallback((value,optsOrCurr)=>{
    const opts=typeof optsOrCurr==='string'?{from:optsOrCurr}:(optsOrCurr||{})
    return format(value,opts.from??region.stockCurrency,opts)
  },[format,region.stockCurrency])
  const toUSD=useCallback((value,fromCurrency)=>convert(value,fromCurrency,'USD'),[convert])
  return <RegionContext.Provider value={{region,regionId,setRegionId,rates,ratesLoaded,fxAsOf,formatCurrency,formatPrice,toUSD}}>{children}</RegionContext.Provider>
}
export function useRegion(){const context=useContext(RegionContext);if(!context)throw Error('RegionProvider required');return context}
