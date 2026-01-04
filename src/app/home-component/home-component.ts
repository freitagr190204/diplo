import {Component, signal, effect, OnInit, OnDestroy} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {CommonModule} from '@angular/common';

@Component({
  selector: 'app-home-component',
  imports: [
    FormsModule,
    CommonModule
  ],
  templateUrl: './home-component.html',
  styleUrl: './home-component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  isConnected = signal(false);
  hasServer = signal(false);
  isClient = signal(false);
  serverUrl = signal('localhost:4203');
  serverPort = signal('4203');
  connectionRole = signal<'server' | 'client' | 'disconnected'>('disconnected');
  statusMessage = signal('Not connected');
  private statusCheckInterval: any;

  constructor() {
    effect(() => {
      console.log("effect")
      const role = this.connectionRole();
      if (role === 'server') {
        this.statusMessage.set('Server - Waiting for client...');
      } else if (role === 'client') {
        this.statusMessage.set('Client - Connected to server');
      } else {
        this.statusMessage.set('Not connected');
      }
    });
  }

  ngOnInit() {
    this.checkConnectionStatus();
    this.statusCheckInterval = setInterval(() => {
      this.checkConnectionStatus();
    }, 1000);
  }

  ngOnDestroy() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }
  }

  private async checkConnectionStatus() {
    try {
      // @ts-ignore
      const status = await window.api.getConnectionStatus();
      if (status) {
        if (this.connectionRole()!== status.status){
          console.log("Connection Status changed " + status.status);
        }
        this.connectionRole()
        this.connectionRole.set(status.status);
        this.isConnected.set(status.status !== 'disconnected');
        this.hasServer.set(status.isServer);
        this.isClient.set(status.isClient);
      }
    } catch (e) {
      console.error('Error checking status:', e);
    }
  }

  protected async launchGame() {
    // Auto-connect if not connected
    if (!this.isConnected()) {
      await this.autoConnect();
    }

    // Wait a bit for connection to establish
    await new Promise(resolve => setTimeout(resolve, 500));

    // Launch game (random selection happens in main.js)
    // @ts-ignore
    window.api.launchGame();
  }

  protected async autoConnect() {
    try {
      this.statusMessage.set('Connecting...');
      // @ts-ignore
      const result = await window.api.autoConnect(this.serverUrl(), this.serverPort());
      if (result && result.success) {
        this.connectionRole.set(result.role);
        this.isConnected.set(true);
        if (result.role === 'server') {
          this.hasServer.set(true);
        } else {
          this.isClient.set(true);
        }
        this.statusMessage.set(`Connected as ${result.role}`);
      }
    } catch (e) {
      console.error('Auto-connect error:', e);
      this.statusMessage.set('Connection failed');
    }
  }

  protected async createServer() {
    // @ts-ignore
    const success = (await window.api.createServerWithPort(this.serverPort())).success;
    console.log(success);
    this.hasServer.set(success);
    if (success) {
      this.connectionRole.set('server');
      this.isConnected.set(true);
    }
  }

  protected async connect() {
    // @ts-ignore
    const success = (await window.api.connectWithUrl(this.serverUrl())).success;
    console.log(success);
    this.isConnected.set(success);
    if (success) {
      this.connectionRole.set('client');
      this.isClient.set(true);
    }
  }

  protected async stopServer() {
    await this.disconnect_only();
    // @ts-ignore
    const success = (await window.api.stopWsServer()).success;
    console.log(success);
    if (success) {
      this.hasServer.set(false);
      this.connectionRole.set('disconnected');
      this.isConnected.set(false);
    }
  }

  protected async disconnect() {
    if (this.connectionRole() ==="server"){
      await this.stopServer();
      return;
    }
    await this.disconnect_only();
  }
  protected async disconnect_only(){
    // @ts-ignore
    await window.api.disconnectFromServer();
    this.isConnected.set(false);
    this.connectionRole.set('disconnected');
    this.isClient.set(false);
  }

  protected closeGame() {
    // @ts-ignore
    window.api.closeGame();
  }
}
