import { OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import type { ConfigKind } from '@ccgs/shared';
import { isAllowedOrigin } from '../security/origin';

@WebSocketGateway({
  namespace: '/live',
  cors: { origin: (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => cb(null, isAllowedOrigin(o)) },
  allowRequest: (req: any, cb: (err: string | null, ok: boolean) => void) => cb(null, isAllowedOrigin(req.headers.origin)),
})
export class LiveGateway implements OnGatewayInit {
  @WebSocketServer() server: Server;

  afterInit() {}

  emit(event: string, payload: unknown) {
    this.server?.emit(event, payload);
  }

  emitConfigChanged(kinds: ConfigKind[]) {
    this.server?.emit('config:changed', { kinds });
  }
}
