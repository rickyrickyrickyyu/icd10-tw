import { Component } from 'react';

/**
 * 單一頁面出錯時只讓那一頁顯示錯誤，搜尋列與其他頁照常可用。
 * 沒有這層時，任何一個元件丟例外 React 會卸載整棵樹 → 整站白畫面（實測踩過）。
 * App 以路由當 key 包住內容，換頁即重置。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p>這一頁發生錯誤：{String(this.state.error?.message ?? this.state.error)}</p>
          <p className="mt-1">可以回<a className="underline" href="#/">首頁</a>或換個查詢；問題持續請回報這段文字。</p>
        </div>
      );
    }
    return this.props.children;
  }
}
