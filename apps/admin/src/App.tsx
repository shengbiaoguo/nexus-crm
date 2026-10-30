import { useState } from 'react';
import { Alert, Button, Card, Layout, Space, Typography } from 'antd';
import { API_PREFIX } from '@nexus/shared';
import { isHealthyResponse } from './health.mjs';

export default function App() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  async function checkHealth() {
    setStatus('loading');
    try {
      const response = await fetch(`${API_PREFIX}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || !isHealthyResponse(await response.json())) throw new Error('Unavailable');
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }
  return (
    <Layout className="shell">
      <Layout.Content>
        <Card>
          <Space orientation="vertical" size="large">
            <Typography.Title level={1}>Nexus CRM</Typography.Title>
            <Typography.Paragraph>工程初始化完成，业务功能将在后续阶段接入。</Typography.Paragraph>
            <Button
              type="primary"
              loading={status === 'loading'}
              onClick={() => void checkHealth()}
            >
              检查服务连接
            </Button>
            {status === 'ok' && <Alert type="success" title="服务连接正常" showIcon />}
            {status === 'error' && (
              <Alert type="error" title="暂时无法连接服务，请稍后重试。" showIcon />
            )}
          </Space>
        </Card>
      </Layout.Content>
    </Layout>
  );
}
