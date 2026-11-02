import {createContext,useState,useEffect,useCallback,useContext} from 'react'
import {authAPI} from '../services/api'
const AuthContext=createContext(null)
export function AuthProvider({children}) {
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true)
  const refreshUser=useCallback(async()=>{
    const [{data:identity},{data:account}]=await Promise.all([authAPI.me(),authAPI.account()])
    const next={...identity.user,user_id:identity.user.id,balance:account.account.cashBalance}
    setUser(next);return next
  },[])
  useEffect(()=>{
    localStorage.removeItem('token');localStorage.removeItem('user')
    const clear=()=>setUser(null)
    window.addEventListener('paper:unauthenticated',clear)
    refreshUser().catch(()=>setUser(null)).finally(()=>setLoading(false))
    return()=>window.removeEventListener('paper:unauthenticated',clear)
  },[refreshUser])
  const login=useCallback(async(username,password)=>{
    await authAPI.login(username,password);const next=await refreshUser()
    window.dispatchEvent(new Event('paper:authenticated'));return next
  },[refreshUser])
  const register=useCallback(async(username,email,password)=>(await authAPI.register(username,email,password)).data,[])
  const logout=useCallback(async()=>{
    try{await authAPI.logout();setUser(null)}catch(error){if(error.response?.status===401)setUser(null);else throw error}
  },[])
  return <AuthContext.Provider value={{user,loading,login,register,logout,refreshUser}}>{children}</AuthContext.Provider>
}
export function useAuth(){const context=useContext(AuthContext);if(!context)throw Error('AuthProvider required');return context}
