import { Component } from 'react';
import type { ReactNode } from 'react';
import { Button, Result } from 'antd';

interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  hasError: boolean;
}

export class GlobalErrorBoundary extends Component<GlobalErrorBoundaryProps, GlobalErrorBoundaryState> {
  override state: GlobalErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): GlobalErrorBoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="error-shell">
          <Result
            status="error"
            title="页面发生异常"
            subTitle="页面未能正常显示。可以重新加载后重试；问题持续时请联系管理员。"
            extra={<Button type="primary" onClick={() => window.location.reload()}>重新加载</Button>}
          />
        </main>
      );
    }
    return this.props.children;
  }
}
