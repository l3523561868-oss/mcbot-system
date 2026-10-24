package com.example.mcbotconsole;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);            // 控制台前端是 JS 应用，必须开
        ws.setDomStorageEnabled(true);           // 部分前端状态需要
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);

        // 所有链接/跳转都在 WebView 内打开，不弹外部浏览器
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(android.webkit.WebView view, int errorCode,
                                       String description, String failingUrl) {
                Toast.makeText(MainActivity.this,
                        "加载失败：" + description + "\n请检查地址/网络", Toast.LENGTH_LONG).show();
            }
        });

        String url = getString(R.string.console_url);
        webView.loadUrl(url);
    }

    // 手机返回键：先退网页历史，再退 App
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
