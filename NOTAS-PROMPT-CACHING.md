TAREFA: CORRIGIR A CONFIGURAÇÃO DE CONEXÃO E IMPLEMENTAR UM ORQUESTRADOR INTELIGENTE DE ROTEAMENTO AUTOMÁTICO

Você deverá investigar, testar e implementar melhorias no proxy existente, principalmente na página Conexão, na configuração de provedores, no roteamento automático e na seleção de modelos para requisições de IA.

IMPORTANTE: Não comece modificando arquivos imediatamente. Primeiro, entenda a arquitetura atual, identifique como cada funcionalidade funciona, execute os testes existentes e determine o que realmente precisa ser corrigido.

O objetivo não é apenas adicionar opções à interface. Quero que as funcionalidades funcionem de verdade, inclusive nas requisições reais feitas ao proxy.

Não invente resultados de testes, não simule sucesso quando uma requisição real falhar e não considere uma funcionalidade concluída apenas porque a interface foi modificada.

1. INVESTIGAÇÃO INICIAL OBRIGATÓRIA

Antes de alterar o código:

Analise a estrutura completa do projeto.

Identifique frontend, backend, serviço de proxy, configurações, armazenamento de provedores e sistema de roteamento de modelos.

Localize a página Conexão e os componentes responsáveis pelas seguintes áreas:

Base URL.

Provedores configurados.

Contas e chaves.

Seleção de provedor principal.

Modo automático.

Provedores gratuitos e pagos.

Roteamento para serviços de pesquisa na web.

Descubra como o proxy é iniciado e como a porta 3005 é definida.

Descubra se as configurações são salvas em arquivo, banco de dados, armazenamento local ou memória.

Identifique como os aplicativos clientes recebem a Base URL e como as requisições chegam ao proxy.

Mapeie o caminho completo de uma requisição no modo automático, desde a escolha do modelo até a resposta final.

Identifique os testes existentes, os comandos de execução e os procedimentos de build.

Antes de implementar, procure especificamente por:

Lógica de seleção automática de provedores.

Lógica de fallback entre modelos e provedores.

Regras de prioridade.

Seleção manual versus automática.

Provedores desabilitados.

Limites de requisições e cotas gratuitas.

Tratamento de erros HTTP.

Timeouts e cancelamento.

Registro de logs e diagnóstico.

Tratamento de ferramentas, chamadas de função e pesquisa na web.

Compatibilidade entre os formatos de requisição dos diferentes provedores.

Não duplique funcionalidades que já existem. Se o projeto já possuir partes de um orquestrador, aproveite e corrija a implementação existente.

Depois dessa análise, siga para a implementação sem parar para pedir autorização a cada etapa. Se houver alguma limitação real, documente-a e continue com as partes que puder implementar com segurança.

2. BASE URL: ADICIONAR SUPORTE A LOCALHOST E 127.0.0.1

Na página Conexão, atualmente aparece uma Base URL semelhante a:

http://localhost:3005

Quero que o sistema também ofereça:

http://127.0.0.1:3005

2.1. Comportamento esperado

Investigue como a Base URL é construída, exibida, copiada, persistida e utilizada pelos aplicativos clientes.

Implemente uma maneira clara de disponibilizar os dois endereços locais, respeitando a arquitetura existente.

Preferencialmente, apresente os endereços como alternativas selecionáveis ou copiáveis, por exemplo:

Localhost: http://localhost:3005

IP local: http://127.0.0.1:3005

Se já existir um mecanismo de seleção ou cópia de URL, reutilize-o.

O usuário deve conseguir copiar a URL escolhida sem precisar editá-la manualmente.

Não substitua silenciosamente a URL atual nem quebre integrações que já utilizam localhost.

2.2. Investigar a porta 3005

Não presuma que a porta seja fixa.

Verifique:

Onde a porta é configurada.

Se existe uma variável de ambiente para ela.

Se o servidor pode escolher uma porta alternativa quando a porta padrão estiver ocupada.

Se o frontend presume que a porta será sempre 3005.

Se o endereço exibido corresponde à porta real em que o servidor está escutando.

Se os aplicativos clientes recebem o endereço de alguma configuração central.

Se a porta for configurável, a Base URL deverá refletir a porta efetivamente utilizada.

Se houver suporte a porta dinâmica, não mantenha 3005 fixo em componentes que deveriam consultar a configuração real.

Se o sistema ainda não oferecer porta dinâmica, não introduza uma mudança arquitetural desnecessária. Documente o comportamento atual e, se apropriado, centralize a configuração para evitar divergências.

2.3. Diferenciar os ambientes

O sistema deve distinguir, quando aplicável:

Execução local.

Acesso pela rede local.

Execução em servidor remoto.

Execução atrás de proxy reverso.

Execução com HTTPS.

localhost e 127.0.0.1 representam a máquina em que o cliente está executando. Eles não apontam automaticamente para um servidor remoto.

Portanto, não exiba essas URLs como endereços universais para qualquer implantação.

Se o proxy estiver hospedado em um servidor remoto, a URL deverá ser obtida da configuração correspondente ao ambiente. Não tente descobrir ou inventar um domínio público.

2.4. Testes obrigatórios

Teste:

Inicialização na porta padrão.

Inicialização em uma porta configurada, caso suportada.

Acesso via localhost.

Acesso via 127.0.0.1.

Cópia dos dois endereços na interface.

Persistência das configurações.

Compatibilidade com configurações antigas.

Uma URL aparecer na interface não prova que o servidor está acessível por ela. Valide o comportamento real sempre que o ambiente permitir.

3. PROVEDOR PRINCIPAL: PERMITIR DESABILITAR A SELEÇÃO MANUAL OBRIGATÓRIA

Na página Conexão, na seção Provedores configurados → Contas e chaves, atualmente existe a possibilidade de selecionar um provedor como principal.

Essa função pode ser útil, mas quero que ela seja opcional.

O modo automático deve ser uma alternativa real à escolha manual.

3.1. Novo comportamento

Implemente dois modos de roteamento claramente definidos:

Modo automático

O usuário ativa o modo automático.

Não é obrigatório escolher um provedor principal.

O sistema decide qual provedor e modelo utilizar para cada requisição.

A decisão considera a tarefa, a capacidade do modelo, a disponibilidade do provedor e as configurações do usuário.

Se um provedor falhar, o sistema poderá tentar outro candidato compatível, respeitando as regras de fallback.

Modo manual

O usuário pode selecionar um provedor principal ou um modelo específico, conforme os recursos já existentes.

O sistema respeita a escolha explícita do usuário.

O sistema não troca silenciosamente para outro provedor quando isso contrariar a escolha manual.

Se já existir um campo para definir o provedor principal, adapte seu significado e sua interface sem quebrar as configurações antigas.

3.2. Regras importantes

O modo automático deve ser o padrão para instalações novas, conforme o comportamento atual desejado.

Se o usuário selecionar um provedor manualmente, o sistema deve respeitar essa escolha.

Se o usuário voltar para o modo automático, a seleção manual não deve continuar bloqueando o roteamento.

Um provedor desabilitado nunca deve ser selecionado pelo modo automático.

Um provedor configurado, mas sem credenciais válidas, não deve ser considerado utilizável.

Se não existir nenhum candidato compatível, retorne um erro claro explicando o motivo.

Não altere nem apague as chaves de API existentes ao trocar de modo.

Se a seleção principal atual for usada como preferência, preserve-a apenas como preferência quando isso fizer sentido, sem transformá-la em uma obrigação no modo automático.

A interface deve deixar claro qual modo está ativo e como alternar entre eles.

4. AUDITORIA REAL DO ROTEAMENTO AUTOMÁTICO EXISTENTE

Antes de construir um novo sistema, descubra se o roteamento automático atual realmente funciona.

Não quero apenas uma revisão visual ou uma análise estática do código.

Quero testes funcionais, utilizando os mecanismos reais de seleção, envio e tratamento de respostas do proxy.

4.1. Testar o modo automático de ponta a ponta

Prepare requisições para testar:

Uma tarefa simples de texto.

Uma tarefa de programação que exija raciocínio.

Uma tarefa que precise de ferramentas, caso o projeto ofereça esse recurso.

Uma pesquisa na web.

Uma requisição em que o primeiro provedor falhe.

Uma requisição sem nenhum provedor compatível.

Uma requisição com provedor desabilitado.

Uma requisição com chave inválida ou ausente, utilizando ambiente de teste seguro.

Para cada teste, confirme:

Se o modo automático foi reconhecido.

Se o sistema selecionou um candidato válido.

Se o modelo escolhido suporta a tarefa.

Se a requisição foi realmente enviada ao destino correto.

Se a resposta foi recebida e processada.

Se o fallback funcionou quando necessário.

Se o resultado retornado ao cliente corresponde ao resultado do provedor.

Se os logs permitem entender o que aconteceu.

Não considere um teste aprovado apenas porque a API interna retornou HTTP 200. Verifique se houve uma resposta válida e coerente com a requisição.

4.2. Testar provedores gratuitos e pagos

Quero verificar o roteamento automático em três situações:

A. Provedores gratuitos

Teste os provedores gratuitos que já estejam implementados e acessíveis no ambiente.

Verifique a seleção automática, o envio, a resposta, os limites de uso e o tratamento de cotas esgotadas.

B. Provedores pagos

Teste os provedores pagos para os quais existam credenciais válidas e autorizadas no ambiente.

Verifique se a seleção automática consegue escolher um modelo compatível e se a resposta é processada corretamente.

C. Cenário misto

Quando existirem candidatos gratuitos e pagos, verifique se o sistema consegue avaliar ambos e selecionar uma opção de acordo com a política de roteamento.

Não presuma que o gratuito é sempre melhor ou que o pago é sempre superior.

A decisão deve considerar a capacidade necessária, a disponibilidade, a latência, o custo e as preferências configuradas.

4.3. Não inventar testes reais

Se não houver credenciais válidas, acesso à internet, saldo, cota disponível ou acesso a um provedor, registre isso como uma limitação do ambiente.

Nesse caso:

Execute os testes automatizados com mocks controlados.

Separe claramente testes simulados de testes reais.

Não informe que um provedor real funcionou se ele não foi efetivamente testado.

Não exponha chaves ou dados sensíveis nos logs.

Não faça chamadas que gerem custos sem autorização ou configuração prévia do usuário.

Ao concluir a auditoria, corrija os defeitos encontrados antes de considerar a implementação pronta.

5. IMPLEMENTAR UM ORQUESTRADOR INTELIGENTE DE REQUISIÇÕES

Quero que você implemente ou consolide um orquestrador central para o modo automático.

Ele deverá funcionar tanto para provedores de modelos de IA com chaves de API quanto para o sistema de pesquisa na web.

O objetivo é impedir que o modo automático seja apenas um seletor superficial que escolhe qualquer modelo disponível sem considerar se ele é adequado para a tarefa.

O orquestrador deve ser integrado à arquitetura existente e utilizado pelas rotas reais do proxy.

Não crie uma implementação isolada que funcione apenas em testes.

5.1. Arquitetura conceitual

Organize a lógica em etapas bem definidas:

Receber a requisição.

Identificar o tipo de tarefa.

Identificar as capacidades exigidas.

Consultar as configurações do usuário.

Descobrir os provedores e modelos elegíveis.

Filtrar candidatos incompatíveis ou indisponíveis.

Classificar os candidatos.

Selecionar o melhor candidato disponível.

Executar a requisição.

Avaliar o resultado técnico.

Aplicar fallback quando permitido.

Retornar a resposta final.

Registrar informações de diagnóstico sem expor segredos.

Adapte essa arquitetura ao projeto existente. Os nomes das classes, serviços e arquivos devem seguir os padrões já utilizados.

5.2. Classificação de tarefas

O orquestrador deverá reconhecer, sempre que possível, categorias como:

Conversa e texto simples.

Programação simples.

Programação complexa.

Raciocínio complexo.

Análise de arquivos e documentos.

Visão e interpretação de imagens.

Pesquisa na web.

Uso de ferramentas e chamadas de função.

Geração estruturada de dados.

Outras categorias já relevantes para o projeto.

A classificação não deve depender exclusivamente de palavras-chave frágeis.

Utilize os metadados da requisição, os recursos solicitados, o modelo escolhido pelo usuário e os sinais disponíveis no sistema.

Se a classificação não for confiável, utilize uma categoria genérica segura e escolha um candidato que satisfaça os requisitos explícitos.

Não faça chamadas extras a modelos de IA apenas para classificar todas as requisições. Prefira uma classificação local, rápida e determinística, salvo se a arquitetura existente já oferecer um mecanismo apropriado e houver uma justificativa clara para utilizá-lo.

5.3. Requisitos e capacidades dos modelos

Cada candidato deve ser avaliado pelas capacidades que realmente oferece.

Considere, conforme os dados disponíveis:

Suporte a texto.

Capacidade de raciocínio.

Contexto máximo.

Suporte a imagens.

Chamadas de ferramentas.

Formato de resposta estruturada.

Compatibilidade com streaming.

Compatibilidade com o formato de API utilizado.

Disponibilidade atual.

Custo.

Limites e cotas.

Latência observada.

Preferências do usuário.

Não invente capacidades que não estejam documentadas ou verificadas.

Se o catálogo existente não tiver informações suficientes sobre os modelos, implemente uma representação de capacidades com valores desconhecidos quando necessário. Não considere uma capacidade desconhecida como garantidamente suportada.

Antes de enviar uma requisição, descarte candidatos que não atendam aos requisitos obrigatórios da tarefa.

5.4. Estratégia de seleção

Implemente uma política de seleção explícita, previsível e testável.

A ordem de decisão deve ser aproximadamente esta:

Respeitar o modo manual quando estiver ativo.

Aplicar as preferências e restrições configuradas pelo usuário.

Eliminar provedores desabilitados, sem credenciais válidas ou incompatíveis.

Eliminar modelos que não atendam às capacidades obrigatórias.

Considerar disponibilidade, limites, custo e latência.

Classificar os candidatos restantes de acordo com a tarefa.

Selecionar o melhor candidato elegível.

Manter alternativas para fallback.

Não use uma pontuação arbitrária que possa fazer um modelo incapaz de executar uma tarefa ser escolhido apenas porque é gratuito ou rápido.

As capacidades obrigatórias são filtros, não simples fatores de pontuação.

Exemplos esperados

Tarefa simples de texto: priorizar um candidato econômico, rápido e confiável.

Programação complexa: priorizar modelos com capacidade adequada de raciocínio e programação, sem depender exclusivamente de serem gratuitos ou pagos.

Análise de imagem: excluir modelos que não suportem imagens quando elas forem necessárias para a tarefa.

Pesquisa na web: selecionar uma ferramenta ou provedor de pesquisa que realmente consiga pesquisar na web. Não escolher um modelo de texto comum e considerar que a pesquisa foi realizada.

Uso de ferramentas: selecionar modelos e provedores compatíveis com as chamadas de função exigidas pela requisição.

Esses exemplos são orientações de comportamento, não uma lista rígida de modelos específicos.

5.5. Preferência por opções gratuitas e pagas

O modo automático deve considerar tanto provedores gratuitos quanto pagos.

Se o usuário configurar preferência por menor custo, o orquestrador deverá priorizar opções gratuitas ou mais baratas quando forem adequadas.

Se o usuário configurar prioridade para qualidade, o sistema deverá considerar modelos mais capazes, respeitando os limites de custo definidos.

Se o usuário configurar um orçamento máximo ou uma restrição de custo, ela deverá ser respeitada.

Não invente um orçamento padrão que possa causar gastos inesperados.

Se não existir uma política de custo na aplicação, crie uma configuração simples e compatível com o sistema atual, com comportamento padrão conservador.

Importante: o modo automático não deve enviar a mesma requisição a vários provedores simultaneamente sem uma justificativa explícita. Isso pode desperdiçar créditos, multiplicar custos e dificultar o diagnóstico.

Comece com seleção inteligente e execução de um único candidato. Use fallback sequencial apenas quando necessário.

6. ORQUESTRADOR ESPECÍFICO PARA PESQUISA NA WEB

O roteamento de pesquisa na web precisa ser tratado como uma capacidade distinta do roteamento de modelos de texto.

Investigue como a pesquisa na web é implementada atualmente, quais provedores existem, quais exigem chaves e como o proxy executa as consultas.

Integre o orquestrador às rotas reais de pesquisa.

6.1. Seleção de provedores de pesquisa

Quando o usuário estiver no modo automático, o sistema deverá:

Identificar que a operação exige pesquisa na web.

Listar os provedores de pesquisa configurados.

Excluir provedores desabilitados, inválidos ou incompatíveis.

Considerar disponibilidade, cotas, custo e latência.

Selecionar um provedor elegível.

Executar a pesquisa.

Validar se a resposta contém resultados utilizáveis.

Acionar fallback quando a falha permitir.

Retornar os resultados ao cliente.

Não misture automaticamente provedores de pesquisa na web com provedores de geração de texto. Eles possuem funções diferentes, mesmo quando fazem parte da mesma experiência de IA.

Se a aplicação oferecer pesquisa seguida de síntese por um modelo de linguagem, mantenha essas etapas separadas e faça a integração corretamente.

6.2. Falhas de pesquisa

Trate explicitamente situações como:

Chave inválida.

Provedor indisponível.

Timeout.

Cota esgotada.

Limite de requisições atingido.

Resposta vazia.

Resposta inválida.

Falha temporária.

Erro de autenticação ou permissão.

Se houver outro provedor de pesquisa compatível, tente-o quando apropriado.

Se nenhum provedor funcionar, retorne um erro claro. Nunca afirme que a pesquisa foi realizada quando nenhuma consulta válida tiver sido concluída.

Não repita pesquisas indefinidamente e não faça fallback para uma resposta de modelo comum fingindo que ela contém resultados atuais da web.

7. FALLBACK INTELIGENTE E TRATAMENTO DE FALHAS

O fallback deverá ser uma parte central do orquestrador, não uma coleção de tentativas improvisadas espalhadas pelo código.

7.1. Quando tentar outro candidato

Considere fallback para falhas recuperáveis, como:

Timeout.

Indisponibilidade temporária.

Erros HTTP 429.

Erros HTTP 5xx.

Cota esgotada.

Falha temporária de conexão.

Incompatibilidade técnica descoberta durante a execução, quando for seguro tentar outro candidato.

Use os dados do provedor para distinguir erros temporários de erros permanentes.

Não faça fallback cego para erros de autenticação, parâmetros inválidos ou requisições que certamente falhariam da mesma maneira em todos os provedores.

7.2. Evitar tentativas inúteis

Implemente:

Número máximo configurável ou claramente limitado de tentativas.

Timeout por tentativa.

Limite de tempo total da operação.

Evitação de candidatos que já falharam na mesma requisição.

Respeito aos limites de concorrência.

Backoff para novas tentativas quando apropriado.

Cancelamento quando o cliente desconectar, se suportado.

Proteção contra ciclos de fallback.

Logs com o motivo de cada decisão.

Não repita uma requisição indefinidamente em um provedor que já demonstrou uma falha permanente.

Não coloque toda a aplicação em espera por causa de um provedor indisponível.

7.3. Segurança e integridade das requisições

O fallback não deve:

Expor chaves de API.

Repetir chamadas com efeitos colaterais sem avaliar a segurança da repetição.

Reexecutar indiscriminadamente ferramentas que já tenham sido executadas.

Duplicar gastos desnecessariamente.

Ignorar a escolha manual do usuário.

Trocar silenciosamente de provedor quando a requisição exigir um destino específico.

Remover parâmetros, mensagens, anexos ou ferramentas importantes da requisição.

Quando não for seguro repetir uma operação, retorne o erro original ou uma explicação clara ao cliente.

7.4. Streaming

Investigue se o proxy oferece streaming de respostas.

Se oferecer, preserve o comportamento existente.

Uma vez que parte da resposta tenha sido enviada ao cliente, não inicie outro provedor e concatene respostas como se fossem uma única geração contínua.

Se o streaming falhar antes do envio de conteúdo, o fallback poderá ocorrer quando for seguro.

Se falhar depois do início da resposta, encerre a operação de maneira coerente e registre o motivo.

8. DIAGNÓSTICO E OBSERVABILIDADE

Quero conseguir entender por que o modo automático escolheu determinado provedor.

Implemente logs estruturados ou aproveite os mecanismos existentes para registrar informações como:

Identificador da requisição.

Tipo de tarefa detectado.

Modo de roteamento utilizado.

Candidatos avaliados.

Motivos de exclusão dos candidatos.

Provedor e modelo selecionados.

Tempo de resposta.

Quantidade de tentativas.

Motivo do fallback.

Resultado final.

Categoria de erro, quando houver.

Não registre:

Chaves de API.

Tokens de acesso.

Senhas.

Conteúdo sensível desnecessário.

Cabeçalhos de autenticação completos.

Se a interface já possuir uma área de diagnóstico, integre essas informações a ela. Caso contrário, priorize logs úteis no backend antes de criar uma nova tela.

Evite registrar todo o conteúdo de cada conversa apenas para facilitar o diagnóstico.

9. CONFIGURAÇÃO E EXPERIÊNCIA DO USUÁRIO

Na página Conexão, organize as opções de maneira clara e coerente com o design atual.

O usuário deverá conseguir:

Copiar a Base URL local via localhost.

Copiar a Base URL local via 127.0.0.1.

Entender qual endereço está sendo utilizado.

Identificar a porta real do serviço.

Alternar entre roteamento automático e manual.

Selecionar um provedor principal no modo manual.

Usar o modo automático sem selecionar um principal.

Consultar quais provedores estão configurados e habilitados.

Entender por que o roteador não encontrou um candidato, quando isso acontecer.

Não transforme a página em um painel excessivamente complexo.

Reaproveite componentes, padrões de interface e mecanismos de persistência já existentes.

Todas as opções precisam refletir o estado real do backend. Não crie controles decorativos que não alterem o comportamento das requisições.

10. COMPATIBILIDADE E MIGRAÇÃO

Preserve a compatibilidade com as configurações existentes.

Verifique se versões antigas do armazenamento contêm campos relacionados a:

Provedor principal.

Modo automático.

Chaves e contas.

Modelos selecionados.

Provedores habilitados.

URLs e portas.

Se houver necessidade de migrar configurações, faça isso de forma segura, mantendo os valores válidos.

O modo automático deve funcionar mesmo que não exista um provedor principal salvo.

A ausência desse campo não deve causar exceções, travamentos ou falhas de inicialização.

Não apague chaves, contas, preferências ou configurações existentes durante a migração.

11. TESTES AUTOMATIZADOS OBRIGATÓRIOS

Crie ou amplie testes automatizados utilizando o framework já existente no projeto.

Não introduza outro framework desnecessariamente.

Cubra, no mínimo, os cenários abaixo.

11.1. Base URL

URL de localhost.

URL de 127.0.0.1.

Porta padrão.

Porta configurável, se suportada.

Persistência.

Configuração antiga.

Exibição correta na interface.

11.2. Modo de roteamento

Automático sem provedor principal.

Manual com provedor principal.

Alternância entre os modos.

Provedor desabilitado.

Provedor sem chave.

Nenhum candidato disponível.

Preferência por custo.

Preferência por qualidade.

Modelo incompatível com a tarefa.

11.3. Orquestração de modelos

Tarefa simples.

Programação complexa.

Requisito de visão.

Requisito de ferramentas.

Seleção de candidato.

Fallback após erro 429.

Fallback após erro 5xx.

Timeout.

Cota esgotada.

Erro permanente.

Limite de tentativas.

Ausência de duplicação indevida de chamadas.

11.4. Pesquisa na web

Seleção automática de provedor de pesquisa.

Pesquisa bem-sucedida.

Chave inválida.

Timeout.

Cota esgotada.

Resposta vazia.

Fallback para outro provedor de pesquisa.

Nenhum provedor elegível.

Separação entre pesquisa e geração de texto.

11.5. Streaming e segurança

Preservação do streaming.

Falha antes do início da resposta.

Falha após o início do streaming.

Cancelamento, quando suportado.

Não exposição de credenciais.

Não repetição insegura de operações com efeitos colaterais.

Utilize mocks para simular falhas previsíveis e reproduzíveis.

Sempre que houver credenciais e acesso válidos, execute também testes reais controlados, sem gastos desnecessários.

12. VALIDAÇÃO FINAL OBRIGATÓRIA

Depois da implementação:

Execute todos os testes existentes.

Execute os novos testes.

Execute o build de produção.

Execute verificações de tipos e lint, caso existam.

Corrija as falhas causadas pelas mudanças.

Verifique se os arquivos gerados estão atualizados.

Revise se a interface e o backend usam a mesma configuração.

Verifique se o modo automático funciona sem um provedor principal.

Verifique se o modo manual continua funcionando.

Verifique se o roteamento de pesquisa na web não foi confundido com o de geração de texto.

Verifique se as chaves e configurações anteriores foram preservadas.

Execute testes reais dos provedores disponíveis, se possível.

Não modifique arquivos ou módulos sem relação com essa tarefa, a menos que seja necessário para corrigir uma dependência diretamente afetada.

Não remova funcionalidades existentes apenas para simplificar a implementação.

Não desative testes para fazer a suíte passar.

Não esconda falhas com catch genéricos, respostas falsas ou valores padrão silenciosos.

13. RELATÓRIO FINAL

Ao terminar, entregue um relatório objetivo, baseado no que realmente foi executado.

Organize o relatório nas seguintes seções:

A. Diagnóstico inicial

Como o roteamento automático funcionava antes.

Quais problemas foram encontrados.

Como a porta e a Base URL eram definidas.

B. Arquivos modificados

Caminho de cada arquivo alterado.

O que foi modificado.

Por que a alteração foi necessária.

C. Base URL

Como selecionar e copiar localhost e 127.0.0.1.

Como a porta é determinada.

Quais ambientes foram validados.

D. Orquestrador

Como a tarefa é classificada.

Como os candidatos são filtrados e ordenados.

Como o custo e as capacidades são considerados.

Como funcionam o fallback e os limites de tentativas.

Como a pesquisa na web é tratada.

E. Resultados dos testes

Para cada teste, informe:

Nome do teste.

Resultado.

Se foi unitário, de integração, simulado ou real.

Evidência ou comando executado.

Limitações encontradas.

F. Testes reais de provedores

Informe separadamente quais provedores gratuitos, pagos e de pesquisa na web foram realmente testados, quais funcionaram e quais não puderam ser testados.

Não invente nomes de provedores nem declare sucesso sem evidência.

G. Pendências

Liste tudo o que não foi possível validar, os motivos e o que ainda precisa ser feito.

H. Conclusão

Explique se o modo automático está realmente funcional, quais caminhos foram validados de ponta a ponta e quais limitações ainda existem.

CRITÉRIO FINAL DE ACEITAÇÃO

A tarefa só poderá ser considerada concluída quando:

A interface disponibilizar as duas URLs locais sem quebrar o comportamento existente.

A porta exibida corresponder à configuração real aplicável.

O usuário puder utilizar o modo automático sem definir um provedor principal.

A seleção manual continuar funcionando.

O orquestrador estiver conectado às requisições reais do proxy.

A seleção considerar as capacidades necessárias para a tarefa.

Provedores gratuitos e pagos puderem participar do roteamento conforme suas configurações e disponibilidade.

A pesquisa na web possuir seleção e fallback adequados aos provedores de pesquisa existentes.

Os erros forem tratados sem loops, duplicações inseguras ou gastos desnecessários.

Os testes automatizados e o build forem executados e os resultados registrados.

As limitações de testes reais forem declaradas honestamente.

Prioridade máxima: funcionamento real, confiabilidade, compatibilidade e diagnóstico. Não priorize apenas a velocidade de implementação ou a aparência da interface.